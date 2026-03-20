begin;

-- ---------------------------------------------------------------------------
-- 1) Ensure sensitive AI tables are protected from anon/authenticated clients
--    while keeping edge-function service-role access intact.
-- ---------------------------------------------------------------------------
do $$
declare
  tbl text;
  deny_policy text;
begin
  foreach tbl in array array['ai_jobs','ai_job_chunks','ai_cache','sheet_cache'] loop
    if exists (
      select 1
      from information_schema.tables
      where table_schema = 'public'
        and table_name = tbl
    ) then
      execute format('alter table public.%I enable row level security', tbl);

      deny_policy := format('%s_no_client_access', tbl);
      execute format('drop policy if exists %I on public.%I', deny_policy, tbl);
      execute format(
        'create policy %I on public.%I as restrictive for all to anon, authenticated using (false) with check (false)',
        deny_policy,
        tbl
      );
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2) Tighten transient storage path policy (non-breaking):
--    require session-like high-entropy folder prefixes for transient buckets.
-- ---------------------------------------------------------------------------
drop policy if exists "restrict_transient_upload_prefix_entropy" on storage.objects;
create policy "restrict_transient_upload_prefix_entropy"
  on storage.objects
  as restrictive
  for all
  to anon, authenticated
  using (
    bucket_id not in ('document-uploads-1','document-uploads-2','document-uploads-3','document-uploads-4','document-uploads-compare','document-uploads')
    or name = '.session_lock'
    or name ~ '^s_[A-Za-z0-9_]{20,}/.+$'
  )
  with check (
    bucket_id not in ('document-uploads-1','document-uploads-2','document-uploads-3','document-uploads-4','document-uploads-compare','document-uploads')
    or name = '.session_lock'
    or name ~ '^s_[A-Za-z0-9_]{20,}/.+$'
  );

commit;
