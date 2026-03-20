begin;

-- ---------------------------------------------------------------------------
-- 1) AI pipeline tables: force RLS + explicitly deny anon/authenticated access
--    and revoke broad grants. Edge functions use service-role and continue
--    to work without client-side table access.
-- ---------------------------------------------------------------------------
do $$
declare
  tbl text;
  deny_policy text;
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
      execute format('revoke all on public.%I from anon, authenticated, public', tbl);

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
-- 2) Storage hardening: remove lock-file exposure and enforce session-prefixed
--    paths for transient upload buckets.
-- ---------------------------------------------------------------------------
drop policy if exists "restrict_document_upload_path_scope" on storage.objects;
drop policy if exists "restrict_transient_upload_prefix_entropy" on storage.objects;
drop policy if exists "restrict_transient_upload_prefix_entropy_v2" on storage.objects;
drop policy if exists "deny_session_lock_client_access" on storage.objects;

create policy "deny_session_lock_client_access"
  on storage.objects
  as restrictive
  for all
  to anon, authenticated
  using (name <> '.session_lock')
  with check (name <> '.session_lock');

create policy "restrict_transient_upload_prefix_entropy_v2"
  on storage.objects
  as restrictive
  for all
  to anon, authenticated
  using (
    bucket_id not in (
      'document-uploads-1',
      'document-uploads-2',
      'document-uploads-3',
      'document-uploads-4',
      'document-uploads-compare',
      'document-uploads'
    )
    or name ~ '^s_[A-Za-z0-9_]{20,}/.+$'
  )
  with check (
    bucket_id not in (
      'document-uploads-1',
      'document-uploads-2',
      'document-uploads-3',
      'document-uploads-4',
      'document-uploads-compare',
      'document-uploads'
    )
    or name ~ '^s_[A-Za-z0-9_]{20,}/.+$'
  );

commit;
