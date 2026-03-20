begin;

-- Explicitly enforce RLS + deny client access on sensitive AI pipeline tables.
-- This is idempotent and safe with service-role edge functions.
do $$
declare
  tbl text;
  policy_name text;
begin
  foreach tbl in array array['ai_jobs', 'ai_job_chunks', 'ai_cache'] loop
    if exists (
      select 1
      from information_schema.tables
      where table_schema = 'public'
        and table_name = tbl
    ) then
      execute format('alter table public.%I enable row level security', tbl);
      execute format('alter table public.%I force row level security', tbl);

      policy_name := format('%s_no_client_access', tbl);
      execute format('drop policy if exists %I on public.%I', policy_name, tbl);
      execute format(
        'create policy %I on public.%I as restrictive for all to anon, authenticated using (false) with check (false)',
        policy_name,
        tbl
      );
    end if;
  end loop;
end $$;

commit;
