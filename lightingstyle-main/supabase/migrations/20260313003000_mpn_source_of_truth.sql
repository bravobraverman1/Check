begin;

create table if not exists public.mpn_allocator_state (
  singleton boolean primary key default true check (singleton),
  next_mpn bigint not null,
  updated_at timestamptz not null default now()
);

insert into public.mpn_allocator_state (singleton, next_mpn)
values (true, 57324)
on conflict (singleton) do nothing;

create table if not exists public.mpn_reservations (
  mpn bigint primary key,
  draft_id uuid not null,
  current_sku text not null default '',
  state text not null check (state in ('generated', 'attached')),
  attached_sku text,
  created_by_action text,
  attached_by_action text,
  last_action text,
  last_warning_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  attached_at timestamptz
);

create unique index if not exists mpn_reservations_attached_sku_unique
  on public.mpn_reservations (upper(attached_sku))
  where state = 'attached' and attached_sku is not null;

create unique index if not exists mpn_reservations_generated_draft_unique
  on public.mpn_reservations (draft_id)
  where state = 'generated';

create index if not exists mpn_reservations_draft_idx
  on public.mpn_reservations (draft_id, state);

create or replace function public.mpn_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists mpn_allocator_state_set_updated_at on public.mpn_allocator_state;
create trigger mpn_allocator_state_set_updated_at
before update on public.mpn_allocator_state
for each row execute function public.mpn_set_updated_at();

drop trigger if exists mpn_reservations_set_updated_at on public.mpn_reservations;
create trigger mpn_reservations_set_updated_at
before update on public.mpn_reservations
for each row execute function public.mpn_set_updated_at();

create or replace function public.mpn_sync_floor(p_floor_next_mpn bigint)
returns bigint
language plpgsql
as $$
declare
  v_next bigint;
begin
  if p_floor_next_mpn is null or p_floor_next_mpn <= 0 then
    select next_mpn into v_next
    from public.mpn_allocator_state
    where singleton = true;
    return v_next;
  end if;

  insert into public.mpn_allocator_state (singleton, next_mpn)
  values (true, p_floor_next_mpn)
  on conflict (singleton) do update
    set next_mpn = greatest(public.mpn_allocator_state.next_mpn, excluded.next_mpn),
        updated_at = now()
  returning next_mpn into v_next;

  return v_next;
end;
$$;

create or replace function public.mpn_release_generated_draft(p_draft_id uuid)
returns void
language plpgsql
as $$
begin
  if p_draft_id is null then
    return;
  end if;

  delete from public.mpn_reservations
  where draft_id = p_draft_id
    and state = 'generated';
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
  v_allocator_next bigint;
  v_requested public.mpn_reservations%rowtype;
  v_generated public.mpn_reservations%rowtype;
  v_attached public.mpn_reservations%rowtype;
  v_result public.mpn_reservations%rowtype;
  v_transition text;
  v_warning_code text := null;
  v_warning_title text := null;
  v_warning_message text := null;
  v_allocated_mpn bigint := null;
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
  into v_generated
  from public.mpn_reservations
  where draft_id = p_draft_id
    and state = 'generated'
  for update;

  select *
  into v_attached
  from public.mpn_reservations
  where state = 'attached'
    and upper(attached_sku) = v_sku
  for update;

  if p_requested_mpn is not null and p_requested_mpn > 0 then
    select *
    into v_requested
    from public.mpn_reservations
    where mpn = p_requested_mpn
    for update;
  end if;

  if found and v_requested.mpn is not null then
    if v_attached.mpn is null and v_generated.mpn is null then
      if v_requested.state = 'attached' and upper(coalesce(v_requested.attached_sku, '')) <> v_sku then
        v_warning_code := 'mpn_conflict_avoided';
      elsif v_requested.state = 'generated' and v_requested.draft_id <> p_draft_id then
        v_warning_code := 'mpn_conflict_avoided';
      end if;
    end if;
  end if;

  if v_attached.mpn is not null then
    if v_generated.mpn is not null and v_generated.mpn <> v_attached.mpn then
      delete from public.mpn_reservations
      where mpn = v_generated.mpn
        and state = 'generated';
    end if;

    update public.mpn_reservations
    set last_action = v_action,
        last_warning_code = v_warning_code
    where mpn = v_attached.mpn;

    v_result := v_attached;
    v_transition := 'attached_reused';
  elsif v_generated.mpn is not null then
    if v_attach then
      update public.mpn_reservations
      set state = 'attached',
          attached_sku = v_sku,
          current_sku = v_sku,
          attached_by_action = v_action,
          attached_at = now(),
          last_action = v_action,
          last_warning_code = v_warning_code
      where mpn = v_generated.mpn
      returning * into v_result;
      v_transition := 'generated_now_attached';
    else
      update public.mpn_reservations
      set current_sku = v_sku,
          last_action = v_action,
          last_warning_code = v_warning_code
      where mpn = v_generated.mpn
      returning * into v_result;
      v_transition := 'generated_reused';
    end if;
  else
    select next_mpn
    into v_allocator_next
    from public.mpn_allocator_state
    where singleton = true
    for update;

    v_allocated_mpn := v_allocator_next;

    update public.mpn_allocator_state
    set next_mpn = v_allocator_next + 1
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
      v_allocated_mpn,
      p_draft_id,
      v_sku,
      case when v_attach then 'attached' else 'generated' end,
      case when v_attach then v_sku else null end,
      v_action,
      case when v_attach then v_action else null end,
      v_action,
      v_warning_code,
      case when v_attach then now() else null end
    )
    returning * into v_result;

    v_transition := case when v_attach then 'generated_and_attached' else 'generated_new' end;
  end if;

  select next_mpn
  into v_allocator_next
  from public.mpn_allocator_state
  where singleton = true;

  if v_warning_code = 'mpn_conflict_avoided' then
    v_warning_title := 'MPN Conflict Avoided';
    v_warning_message := format(
      'MPN %s was already used by another user or product. The system continued with MPN %s to avoid a duplicate.',
      coalesce(p_requested_mpn::text, 'unknown'),
      v_result.mpn::text
    );
  end if;

  return jsonb_build_object(
    'mpn', v_result.mpn,
    'attachment_state', v_result.state,
    'transition', v_transition,
    'attached_sku', v_result.attached_sku,
    'next_mpn', v_allocator_next,
    'warning_code', v_warning_code,
    'warning_title', v_warning_title,
    'warning_message', v_warning_message
  );
end;
$$;

alter table public.mpn_allocator_state enable row level security;
alter table public.mpn_allocator_state force row level security;
alter table public.mpn_reservations enable row level security;
alter table public.mpn_reservations force row level security;

revoke all on table public.mpn_allocator_state from anon, authenticated, public;
revoke all on table public.mpn_reservations from anon, authenticated, public;

drop policy if exists mpn_allocator_state_no_client_access on public.mpn_allocator_state;
create policy mpn_allocator_state_no_client_access
  on public.mpn_allocator_state
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

drop policy if exists mpn_reservations_no_client_access on public.mpn_reservations;
create policy mpn_reservations_no_client_access
  on public.mpn_reservations
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

revoke all on function public.mpn_sync_floor(bigint) from public, anon, authenticated;
revoke all on function public.mpn_release_generated_draft(uuid) from public, anon, authenticated;
revoke all on function public.mpn_resolve_action(uuid, text, text, bigint) from public, anon, authenticated;

commit;
