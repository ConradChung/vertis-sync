-- Applied 2026-10-08 via the Supabase MCP (version 20261008224840). Tracked here so the repo matches the DB.
-- Aggregate-only read for the rotation dashboard. Returns counts, run rows and cron state; never a lead row.
-- SECURITY DEFINER so anon can call it while lead_bank / rotation_runs keep RLS with no anon policies.
create or replace function public.rotation_dashboard()
returns json
language sql
security definer
set search_path = public, pg_catalog
stable
as $$
with s as (select state::text as state, count(*)::int as n from public.lead_bank group by state),
act as (select count(*)::int as n, min(pushed_at) as oldest_pushed, max(pushed_at) as newest_pushed from public.lead_bank where state='active'),
rep as (select count(*)::int as n, min(delete_after) as next_delete from public.lead_bank where state='replied'),
runs as (select id, ran_at, in_instantly_before, archived, deleted, pushed, in_instantly_after, errors, note from public.rotation_runs order by ran_at desc limit 30),
last as (select * from runs limit 1),
daily as (select date_trunc('day', ran_at) as d, sum(pushed)::int as pushed, sum(deleted)::int as deleted from public.rotation_runs where ran_at > now() - interval '30 days' group by 1 order by 1),
cron as (select j.jobname, j.schedule, j.active,
  (select json_build_object('start', r.start_time, 'status', r.status, 'msg', left(r.return_message,200)) from cron.job_run_details r where r.jobid=j.jobid order by r.start_time desc limit 1) as last_run
  from cron.job j where j.jobname like 'instantly-rotate%')
select json_build_object(
  'now', now(),
  'states', (select json_object_agg(state, n) from s),
  'total', (select sum(n) from s),
  'active', (select row_to_json(act) from act),
  'replied', (select row_to_json(rep) from rep),
  'last_run', (select row_to_json(last) from last),
  'runs', (select coalesce(json_agg(runs), '[]'::json) from runs),
  'daily', (select coalesce(json_agg(daily), '[]'::json) from daily),
  'cron', (select coalesce(json_agg(cron), '[]'::json) from cron));
$$;
revoke all on function public.rotation_dashboard() from public;
grant execute on function public.rotation_dashboard() to anon, authenticated, service_role;
