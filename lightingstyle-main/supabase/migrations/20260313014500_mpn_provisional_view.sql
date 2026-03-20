begin;

create table if not exists public.mpn_drafts (
  draft_id uuid primary key,
  current_sku text not null default '',
  preview_mpn bigint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.mpn_drafts enable row level security;
alter table public.mpn_drafts force row level security;

drop policy if exists "deny_all_mpn_drafts" on public.mpn_drafts;
create policy "deny_all_mpn_drafts"
  on public.mpn_drafts
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

drop trigger if exists mpn_drafts_set_updated_at on public.mpn_drafts;
create trigger mpn_drafts_set_updated_at
before update on public.mpn_drafts
for each row execute function public.mpn_set_updated_at();

insert into public.mpn_drafts (draft_id, current_sku, preview_mpn, created_at, updated_at)
select draft_id, current_sku, mpn, created_at, updated_at
from public.mpn_reservations
where state = 'generated'
on conflict (draft_id) do update
set
  current_sku = excluded.current_sku,
  preview_mpn = excluded.preview_mpn,
  created_at = least(public.mpn_drafts.created_at, excluded.created_at),
  updated_at = greatest(public.mpn_drafts.updated_at, excluded.updated_at);

delete from public.mpn_reservations
where state = 'generated';

drop index if exists mpn_reservations_generated_draft_unique;

create or replace function public.mpn_release_generated_draft(p_draft_id uuid)
returns void
language plpgsql
as $$
begin
  if p_draft_id is null then
    return;
  end if;

  delete from public.mpn_drafts
  where draft_id = p_draft_id;
end;
$$;

create or replace function public.mpn_peek_next()
returns bigint
language plpgsql
as $$
declare
  v_next bigint;
begin
  insert into public.mpn_allocator_state (singleton, next_mpn)
  values (true, 57324)
  on conflict (singleton) do nothing;

  select next_mpn into v_next
  from public.mpn_allocator_state
  where singleton = true;

  if v_next is null or v_next <= 0 then
    v_next := 57324;
    update public.mpn_allocator_state
    set next_mpn = v_next
    where singleton = true;
  end if;

  return v_next;
end;
$$;

create or replace function public.mpn_resolve_action(
  p_draft_id uuid,
  p_sku text,
  p_action text,
  p_requested_mpn bigint default null
)
returns jsonb
language plpgsql
as $$
declare
  v_sku text := upper(trim(coalesce(p_sku, '')));
  v_action text := lower(trim(coalesce(p_action, '')));
  v_attach boolean := v_action in ('send_by_email', 'download');
  v_requested_mpn bigint := case when p_requested_mpn is not null and p_requested_mpn > 0 then p_requested_mpn else null end;
  v_next bigint;
  v_attached public.mpn_reservations%rowtype;
  v_draft public.mpn_drafts%rowtype;
  v_result_mpn bigint;
  v_transition text;
  v_warning_code text := null;
  v_warning_title text := null;
  v_warning_message text := null;
begin
  if p_draft_id is null then
    raise exception 'draft_id is required';
  end if;
  if v_sku = '' then
    raise exception 'sku is required';
  end if;
  if v_action not in ('view', 'send_by_email', 'download') then
    raise exception 'invalid action %', p_action;
  end if;

  insert into public.mpn_allocator_state (singleton, next_mpn)
  values (true, 57324)
  on conflict (singleton) do nothing;

  select *
  into v_attached
  from public.mpn_reservations
  where state = 'attached'
    and upper(attached_sku) = v_sku
  for update;

  if found and v_attached.mpn is not null then
    v_result_mpn := v_attached.mpn;
    v_transition := 'attached_reused';

    update public.mpn_reservations
    set last_action = v_action,
        last_warning_code = null
    where mpn = v_attached.mpn;

    return jsonb_build_object(
      'mpn', v_result_mpn,
      'attachment_state', 'attached',
      'transition', v_transition,
      'attached_sku', v_attached.attached_sku,
      'next_mpn', public.mpn_peek_next()
    );
  end if;

  select *
  into v_draft
  from public.mpn_drafts
  where draft_id = p_draft_id
  for update;

  if not found then
    v_draft := null;
  end if;

  select next_mpn
  into v_next
  from public.mpn_allocator_state
  where singleton = true
  for update;

  if v_next is null or v_next <= 0 then
    v_next := 57324;
    update public.mpn_allocator_state
    set next_mpn = v_next
    where singleton = true;
  end if;

  if not v_attach then
    if v_draft.draft_id is not null then
      update public.mpn_drafts
      set current_sku = v_sku
      where draft_id = p_draft_id;

      v_result_mpn := v_draft.preview_mpn;
      v_transition := 'generated_reused';
    else
      insert into public.mpn_drafts (draft_id, current_sku, preview_mpn)
      values (p_draft_id, v_sku, v_next);
      v_result_mpn := v_next;
      v_transition := 'generated_new';
    end if;

    return jsonb_build_object(
      'mpn', v_result_mpn,
      'attachment_state', 'generated',
      'transition', v_transition,
      'attached_sku', null,
      'next_mpn', v_next
    );
  end if;

  if v_draft.draft_id is not null then
    if v_draft.preview_mpn <> v_next then
      v_warning_code := 'mpn_conflict_avoided';
      v_warning_title := 'MPN Conflict Avoided';
      v_warning_message := format(
        'Displayed MPN %s was already used by another user or product. The system continued with MPN %s to avoid a duplicate.',
        v_draft.preview_mpn::text,
        v_next::text
      );
      v_result_mpn := v_next;
    else
      v_result_mpn := v_draft.preview_mpn;
    end if;
    v_transition := 'generated_now_attached';
  else
    if v_requested_mpn is not null and v_requested_mpn <> v_next then
      v_warning_code := 'mpn_conflict_avoided';
      v_warning_title := 'MPN Conflict Avoided';
      v_warning_message := format(
        'Displayed MPN %s was already used by another user or product. The system continued with MPN %s to avoid a duplicate.',
        v_requested_mpn::text,
        v_next::text
      );
    end if;
    v_result_mpn := v_next;
    v_transition := 'generated_and_attached';
  end if;

  update public.mpn_allocator_state
  set next_mpn = v_result_mpn + 1
  where singleton = true;

  insert into public.mpn_reservations (
    mpn,
    draft_id,
    current_sku,
    state,
    attached_sku,
    created_by_action,
    attached_by_action,
    last_action,
    last_warning_code,
    attached_at
  )
  values (
    v_result_mpn,
    p_draft_id,
    v_sku,
    'attached',
    v_sku,
    v_action,
    v_action,
    v_action,
    v_warning_code,
    now()
  )
  on conflict (mpn) do update
    set current_sku = excluded.current_sku,
        attached_sku = excluded.attached_sku,
        attached_by_action = excluded.attached_by_action,
        last_action = excluded.last_action,
        last_warning_code = excluded.last_warning_code,
        attached_at = coalesce(public.mpn_reservations.attached_at, excluded.attached_at);

  delete from public.mpn_drafts
  where draft_id = p_draft_id;

  return jsonb_build_object(
    'mpn', v_result_mpn,
    'attachment_state', 'attached',
    'transition', v_transition,
    'attached_sku', v_sku,
    'next_mpn', v_result_mpn + 1,
    'warning_code', v_warning_code,
    'warning_title', v_warning_title,
    'warning_message', v_warning_message
  );
end;
$$;

with used_mpn as (
  select mpn from public.mpn_reservations where state = 'attached'
  union
  select mpn from public.mpn_external_reservations
),
series as (
  select generate_series(57324, coalesce((select greatest(max(mpn), 57324) + 1000 from used_mpn), 58324)) as candidate
),
next_candidate as (
  select candidate
  from series
  where not exists (
    select 1 from used_mpn where used_mpn.mpn = series.candidate
  )
  order by candidate
  limit 1
)
update public.mpn_allocator_state
set next_mpn = coalesce((select candidate from next_candidate), 57324)
where singleton = true;

revoke all on table public.mpn_drafts from anon, authenticated;
revoke all on function public.mpn_peek_next() from public, anon, authenticated;

commit;
