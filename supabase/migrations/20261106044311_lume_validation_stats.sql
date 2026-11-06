-- Validator quality per job, as grouped counts (never row by row):
--   lume_validation_stats(job)  → [{status, reason, n}] — status × MailTester
--     message (validation_result->>'message': Accepted, Catch-All, No MX, Greylisted,
--     Rejected, Disposable, MX Error, Timeout, SPAM Block, …; null for no_email / pending).
--   lume_validation_history(days, limit, offset) → completed jobs of the last N days,
--     newest first, each with its source (the ingest's sender / filename), counts
--     by status and its top invalid reason, plus the total for paging.
-- Read-only, service role only. The expression index serves the grouping.
create index if not exists validation_rows_job_status_reason_idx
  on public.validation_rows (job_id, status, (validation_result->>'message'));
create index if not exists validation_jobs_completed_created_idx
  on public.validation_jobs (created_at desc) where status = 'completed';
create index if not exists telegram_ingests_validation_job_idx
  on public.telegram_ingests (validation_job_id) where validation_job_id is not null;

create or replace function public.lume_validation_stats(p_job uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('status', status, 'reason', reason, 'n', n) order by n desc), '[]'::jsonb)
  from (
    select status, validation_result->>'message' as reason, count(*)::int as n
    from public.validation_rows
    where job_id = p_job
    group by 1, 2
  ) g;
$$;

create or replace function public.lume_validation_history(p_days int default 30, p_limit int default 25, p_offset int default 0)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with jobs as (
    select j.id, j.filename, j.source, j.total_rows, j.created_at, j.updated_at
    from public.validation_jobs j
    where j.status = 'completed' and j.created_at >= now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 365))
  ), page as (
    select * from jobs order by created_at desc
    limit least(greatest(coalesce(p_limit, 25), 1), 100) offset greatest(coalesce(p_offset, 0), 0)
  )
  select jsonb_build_object(
    'total', (select count(*) from jobs),
    'jobs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'filename', p.filename, 'source', p.source, 'total_rows', p.total_rows,
        'created_at', p.created_at, 'finished_at', p.updated_at,
        'sender_name', i.sender_name, 'ingest_filename', i.filename,
        'valid', coalesce(c.valid, 0), 'invalid', coalesce(c.invalid, 0), 'error', coalesce(c.error, 0),
        'no_email', coalesce(c.no_email, 0), 'pending', coalesce(c.pending, 0),
        'top_invalid_reason', t.reason, 'top_invalid_count', t.n
      ) order by p.created_at desc)
      from page p
      left join lateral (
        select sender_name, filename from public.telegram_ingests where validation_job_id = p.id order by created_at desc limit 1
      ) i on true
      left join lateral (
        select count(*) filter (where status = 'valid')::int as valid,
               count(*) filter (where status = 'invalid')::int as invalid,
               count(*) filter (where status = 'error')::int as error,
               count(*) filter (where status = 'no_email')::int as no_email,
               count(*) filter (where status = 'pending')::int as pending
        from public.validation_rows where job_id = p.id
      ) c on true
      left join lateral (
        select validation_result->>'message' as reason, count(*)::int as n
        from public.validation_rows where job_id = p.id and status = 'invalid'
        group by 1 order by 2 desc limit 1
      ) t on true
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.lume_validation_stats(uuid) from public, anon, authenticated;
revoke all on function public.lume_validation_history(int, int, int) from public, anon, authenticated;
grant execute on function public.lume_validation_stats(uuid) to service_role;
grant execute on function public.lume_validation_history(int, int, int) to service_role;
