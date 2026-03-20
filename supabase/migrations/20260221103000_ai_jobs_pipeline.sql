create extension if not exists pgcrypto;

create table if not exists public.ai_jobs (
  id uuid primary key default gen_random_uuid(),
  type text not null default 'generic',
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'error', 'cancelled')),
  progress int not null default 0 check (progress >= 0 and progress <= 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  request_payload jsonb not null default '{}'::jsonb,
  result jsonb,
  error text,
  model_used text,
  latency_ms int,
  timing jsonb not null default '{}'::jsonb
);

alter table public.ai_jobs add column if not exists type text not null default 'generic';
alter table public.ai_jobs add column if not exists status text not null default 'queued';
alter table public.ai_jobs add column if not exists progress int not null default 0;
alter table public.ai_jobs add column if not exists created_at timestamptz not null default now();
alter table public.ai_jobs add column if not exists updated_at timestamptz not null default now();
alter table public.ai_jobs add column if not exists request_payload jsonb not null default '{}'::jsonb;
alter table public.ai_jobs add column if not exists result jsonb;
alter table public.ai_jobs add column if not exists error text;
alter table public.ai_jobs add column if not exists model_used text;
alter table public.ai_jobs add column if not exists latency_ms int;
alter table public.ai_jobs add column if not exists timing jsonb not null default '{}'::jsonb;

create index if not exists ai_jobs_status_idx on public.ai_jobs(status);
create index if not exists ai_jobs_created_at_idx on public.ai_jobs(created_at desc);

create table if not exists public.ai_job_chunks (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.ai_jobs(id) on delete cascade,
  chunk_index int not null,
  chunk_type text not null default 'text' check (chunk_type in ('pdf', 'text')),
  text text not null default '',
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'error', 'cancelled')),
  result jsonb,
  error text,
  latency_ms int,
  timing jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.ai_job_chunks add column if not exists job_id uuid;
alter table public.ai_job_chunks add column if not exists chunk_index int;
alter table public.ai_job_chunks add column if not exists chunk_type text not null default 'text';
alter table public.ai_job_chunks add column if not exists text text not null default '';
alter table public.ai_job_chunks add column if not exists status text not null default 'queued';
alter table public.ai_job_chunks add column if not exists result jsonb;
alter table public.ai_job_chunks add column if not exists error text;
alter table public.ai_job_chunks add column if not exists latency_ms int;
alter table public.ai_job_chunks add column if not exists timing jsonb not null default '{}'::jsonb;
alter table public.ai_job_chunks add column if not exists created_at timestamptz not null default now();
alter table public.ai_job_chunks add column if not exists updated_at timestamptz not null default now();

create unique index if not exists ai_job_chunks_job_id_chunk_index_key on public.ai_job_chunks(job_id, chunk_index);
create index if not exists ai_job_chunks_job_id_status_idx on public.ai_job_chunks(job_id, status);
create index if not exists ai_job_chunks_status_idx on public.ai_job_chunks(status);

-- Add FK if table pre-existed without it.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'ai_job_chunks_job_id_fkey'
  ) then
    alter table public.ai_job_chunks
      add constraint ai_job_chunks_job_id_fkey
      foreign key (job_id) references public.ai_jobs(id) on delete cascade;
  end if;
exception
  when duplicate_object then null;
end $$;

create table if not exists public.ai_cache (
  hash text not null,
  mode text not null,
  chunk_index int not null,
  model text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (hash, mode, chunk_index, model)
);

alter table public.ai_cache add column if not exists hash text;
alter table public.ai_cache add column if not exists mode text;
alter table public.ai_cache add column if not exists chunk_index int;
alter table public.ai_cache add column if not exists model text;
alter table public.ai_cache add column if not exists result jsonb;
alter table public.ai_cache add column if not exists created_at timestamptz not null default now();

create index if not exists ai_cache_created_at_idx on public.ai_cache(created_at desc);
create unique index if not exists ai_cache_hash_mode_chunk_model_key on public.ai_cache(hash, mode, chunk_index, model);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_ai_jobs_touch_updated_at on public.ai_jobs;
create trigger trg_ai_jobs_touch_updated_at
before update on public.ai_jobs
for each row execute function public.touch_updated_at();

drop trigger if exists trg_ai_job_chunks_touch_updated_at on public.ai_job_chunks;
create trigger trg_ai_job_chunks_touch_updated_at
before update on public.ai_job_chunks
for each row execute function public.touch_updated_at();
