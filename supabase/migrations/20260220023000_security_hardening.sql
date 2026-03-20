-- Security hardening for edge-function-backed tables and storage buckets.
-- Apply with: supabase db push (or run in Supabase SQL Editor).

begin;

-- ---------------------------------------------------------------------------
-- ai_prompts: block direct client reads/writes.
-- Edge functions use service-role and still work.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'ai_prompts'
  ) then
    execute 'alter table public.ai_prompts enable row level security';

    drop policy if exists "deny_ai_prompts_client_access" on public.ai_prompts;
    create policy "deny_ai_prompts_client_access"
      on public.ai_prompts
      as restrictive
      for all
      to anon, authenticated
      using (false)
      with check (false);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Storage buckets: make buckets private and scope client object access.
-- Restrictive policies narrow access even if permissive policies already exist.
-- ---------------------------------------------------------------------------
update storage.buckets
set public = false
where id in (
  'document-uploads-1',
  'document-uploads-2',
  'document-uploads-3',
  'document-uploads-4',
  'document-uploads-compare',
  'document-uploads-constant',
  'document-uploads'
);

drop policy if exists "restrict_document_upload_bucket_scope" on storage.objects;
create policy "restrict_document_upload_bucket_scope"
  on storage.objects
  as restrictive
  for all
  to anon, authenticated
  using (
    bucket_id = any (
      array[
        'document-uploads-1',
        'document-uploads-2',
        'document-uploads-3',
        'document-uploads-4',
        'document-uploads-compare',
        'document-uploads-constant',
        'document-uploads'
      ]::text[]
    )
  )
  with check (
    bucket_id = any (
      array[
        'document-uploads-1',
        'document-uploads-2',
        'document-uploads-3',
        'document-uploads-4',
        'document-uploads-compare',
        'document-uploads-constant',
        'document-uploads'
      ]::text[]
    )
  );

drop policy if exists "restrict_document_upload_path_scope" on storage.objects;
create policy "restrict_document_upload_path_scope"
  on storage.objects
  as restrictive
  for all
  to anon, authenticated
  using (
    bucket_id in ('document-uploads-constant', 'document-uploads')
    or name = '.session_lock'
    or name like 's_%/%'
  )
  with check (
    bucket_id in ('document-uploads-constant', 'document-uploads')
    or name = '.session_lock'
    or name like 's_%/%'
  );

commit;
