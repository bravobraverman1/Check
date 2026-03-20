begin;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'document-uploads-form-json',
  'document-uploads-form-json',
  false,
  10485760,
  array['application/json']::text[]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

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
        'document-uploads-loading-dock',
        'document-uploads',
        'document-uploads-form-json'
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
        'document-uploads-loading-dock',
        'document-uploads',
        'document-uploads-form-json'
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
    or (bucket_id = 'document-uploads-loading-dock' and name like 'loading-dock-snapshots/%')
    or (bucket_id = 'document-uploads-form-json' and name like 'form-imports/%')
    or name = '.session_lock'
    or name like 's_%/%'
  )
  with check (
    bucket_id in ('document-uploads-constant', 'document-uploads')
    or (bucket_id = 'document-uploads-loading-dock' and name like 'loading-dock-snapshots/%')
    or (bucket_id = 'document-uploads-form-json' and name like 'form-imports/%')
    or name = '.session_lock'
    or name like 's_%/%'
  );

commit;
