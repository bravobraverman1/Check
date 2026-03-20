begin;

create or replace function public.mpn_set_next(
  p_next_mpn bigint
)
returns bigint
language plpgsql
as $$
declare
  v_requested bigint := p_next_mpn;
  v_max_used bigint;
begin
  if v_requested is null or v_requested <= 0 then
    raise exception 'next mpn must be a positive number';
  end if;

  select greatest(
    coalesce((select max(mpn) from public.mpn_reservations where state = 'attached'), 0),
    coalesce((select max(mpn) from public.mpn_external_reservations), 0)
  )
  into v_max_used;

  if v_requested <= v_max_used then
    raise exception 'next mpn must be greater than the highest used mpn (%)', v_max_used;
  end if;

  insert into public.mpn_allocator_state (singleton, next_mpn)
  values (true, v_requested)
  on conflict (singleton) do update
    set next_mpn = excluded.next_mpn,
        updated_at = now();

  return v_requested;
end;
$$;

revoke all on function public.mpn_set_next(bigint) from public, anon, authenticated;

commit;
