begin;

-- ---------------------------------------------------------------------------
-- 1) AI pipeline tables: enforce RLS and deny all anon/authenticated access.
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
      execute format('revoke all on table public.%I from anon, authenticated, public', tbl);

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
-- 2) app_settings: client read-only, server-side writes only.
-- ---------------------------------------------------------------------------
create table if not exists public.app_settings (
  id uuid primary key default gen_random_uuid(),
  setting_name text unique not null,
  setting_value text not null,
  updated_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;
alter table public.app_settings force row level security;

-- Remove broad/permissive write policies (legacy variants included).
drop policy if exists "allow_all_app_settings" on public.app_settings;
drop policy if exists "write_app_settings" on public.app_settings;
drop policy if exists "update_app_settings" on public.app_settings;
drop policy if exists "insert_app_settings" on public.app_settings;
drop policy if exists "delete_app_settings" on public.app_settings;
drop policy if exists "read_app_settings" on public.app_settings;

-- Strip table privileges and grant read-only back to client roles.
revoke all on table public.app_settings from anon, authenticated, public;
grant select on table public.app_settings to anon, authenticated;

create policy "read_app_settings"
  on public.app_settings
  for select
  to anon, authenticated
  using (true);

commit;
