-- Speed up recover_latest lookups that filter by request_payload->>clientSessionId
-- and recent queued/running/done/error statuses.
create index if not exists ai_jobs_client_session_status_created_idx
  on public.ai_jobs ((request_payload->>'clientSessionId'), status, created_at desc);
