begin;

create table if not exists public.mpn_external_reservations (
  mpn bigint primary key,
  source text not null,
  notes text,
  created_at timestamptz not null default now()
);

alter table public.mpn_external_reservations enable row level security;
alter table public.mpn_external_reservations force row level security;

drop policy if exists "deny_all_mpn_external_reservations" on public.mpn_external_reservations;
create policy "deny_all_mpn_external_reservations"
  on public.mpn_external_reservations
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

create or replace function public.mpn_allocate_external(
  p_source text,
  p_notes text default null,
  p_floor_next_mpn bigint default null
)
returns jsonb
language plpgsql
as $$
declare
  v_source text := lower(trim(coalesce(p_source, 'external')));
  v_notes text := nullif(trim(coalesce(p_notes, '')), '');
  v_reserved bigint;
  v_next bigint;
begin
  perform public.mpn_sync_floor(p_floor_next_mpn);

  insert into public.mpn_allocator_state (singleton, next_mpn)
  values (true, 57324)
  on conflict (singleton) do nothing;

  select next_mpn
  into v_reserved
  from public.mpn_allocator_state
  where singleton = true
  for update;

  if not found or v_reserved is null or v_reserved <= 0 then
    raise exception 'mpn allocator is not initialized';
  end if;

  v_next := v_reserved + 1;

  update public.mpn_allocator_state
  set next_mpn = v_next
  where singleton = true;

  insert into public.mpn_external_reservations (mpn, source, notes)
  values (v_reserved, v_source, v_notes);

  return jsonb_build_object(
    'reserved_mpn', v_reserved,
    'next_mpn', v_next,
    'source', v_source
  );
end;
$$;

revoke all on table public.mpn_external_reservations from anon, authenticated;
revoke all on function public.mpn_allocate_external(text, text, bigint) from public, anon, authenticated;

commit;
