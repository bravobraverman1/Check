begin;

-- ---------------------------------------------------------------------------
-- 1) Explicit/static RLS hardening for AI pipeline tables.
--    Keeps service-role edge function access while blocking anon/authenticated.
-- ---------------------------------------------------------------------------
alter table public.ai_jobs enable row level security;
alter table public.ai_jobs force row level security;
revoke all on table public.ai_jobs from anon, authenticated, public;
drop policy if exists ai_jobs_no_client_access on public.ai_jobs;
create policy ai_jobs_no_client_access
  on public.ai_jobs
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

alter table public.ai_job_chunks enable row level security;
alter table public.ai_job_chunks force row level security;
revoke all on table public.ai_job_chunks from anon, authenticated, public;
drop policy if exists ai_job_chunks_no_client_access on public.ai_job_chunks;
create policy ai_job_chunks_no_client_access
  on public.ai_job_chunks
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

alter table public.ai_cache enable row level security;
alter table public.ai_cache force row level security;
revoke all on table public.ai_cache from anon, authenticated, public;
drop policy if exists ai_cache_no_client_access on public.ai_cache;
create policy ai_cache_no_client_access
  on public.ai_cache
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

-- ---------------------------------------------------------------------------
-- 2) app_settings hardening:
--    - keep read access for anon/authenticated
--    - remove direct client write access; writes go through edge functions
-- ---------------------------------------------------------------------------
create table if not exists public.app_settings (
  id uuid primary key default gen_random_uuid(),
  setting_name text unique not null,
  setting_value text not null,
  updated_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;
alter table public.app_settings force row level security;

drop policy if exists "allow_all_app_settings" on public.app_settings;
drop policy if exists "write_app_settings" on public.app_settings;
drop policy if exists "update_app_settings" on public.app_settings;
drop policy if exists "insert_app_settings" on public.app_settings;
drop policy if exists "delete_app_settings" on public.app_settings;
drop policy if exists "read_app_settings" on public.app_settings;

create policy "read_app_settings"
  on public.app_settings
  for select
  to anon, authenticated
  using (true);

do $$
begin
  alter publication supabase_realtime add table public.app_settings;
exception
  when duplicate_object then null;
end $$;

commit;
