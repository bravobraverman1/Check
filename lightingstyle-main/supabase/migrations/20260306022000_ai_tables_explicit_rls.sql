begin;

-- Explicit/static RLS statements for security scanners that do not evaluate
-- dynamic SQL inside DO blocks.
-- Service-role edge functions continue to work; anon/authenticated are denied.

alter table if exists public.ai_jobs enable row level security;
alter table if exists public.ai_jobs force row level security;
revoke all on table public.ai_jobs from anon, authenticated, public;
drop policy if exists ai_jobs_no_client_access on public.ai_jobs;
create policy ai_jobs_no_client_access
  on public.ai_jobs
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

alter table if exists public.ai_job_chunks enable row level security;
alter table if exists public.ai_job_chunks force row level security;
revoke all on table public.ai_job_chunks from anon, authenticated, public;
drop policy if exists ai_job_chunks_no_client_access on public.ai_job_chunks;
create policy ai_job_chunks_no_client_access
  on public.ai_job_chunks
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

alter table if exists public.ai_cache enable row level security;
alter table if exists public.ai_cache force row level security;
revoke all on table public.ai_cache from anon, authenticated, public;
drop policy if exists ai_cache_no_client_access on public.ai_cache;
create policy ai_cache_no_client_access
  on public.ai_cache
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

commit;
