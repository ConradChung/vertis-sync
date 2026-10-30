-- PM influencer reactions fixes (follows lume_influencer_reactions). Money safety:
--
-- 1. lume_influencer_reserve_apify refuses (run_not_running) unless the run
--    is running, checked under a row lock on the run (FOR UPDATE), so a
--    cancel or a failure stops new Apify starts at once, also in the middle
--    of a step. An existing (run, influencer, kind) row is still returned
--    as-is.
-- 2. lume_influencer_fail_run(run, error): fails a running run AND its
--    pending/running Apify rows (cost stays at the reservation), returning
--    the Apify run ids to abort; the edge function calls it on a fatal error.
-- 3. lume_influencer_sweep(...): one sweep for every leak, run on every
--    invocation:
--      - a running run with no heartbeat for p_stale_minutes and no live lease -> failed
--      - a running run older than p_max_run_hours (since approval, else creation) -> failed
--      - a run awaiting the reactions approval for p_awaiting_hours -> cancelled (expired)
--      - Apify rows pending/running under a run that is no longer active -> failed
--      - a pending row with no Apify run id after p_pending_minutes -> failed
--        (the worker died between the reservation and the start; the reservation
--        stays as the cost, the conservative figure)
--      - a running row started more than p_running_minutes ago -> failed
--    It returns (run_id, apify_run_id, reason) for every Apify row it closed,
--    so the caller aborts the live ones on Apify. Reservations of closed rows
--    leave lume_research_reserved_usd 10 minutes after finished_at, as for
--    any finished row.
--    lume_influencer_sweep_stale(minutes) keeps its signature and delegates.

create or replace function public.lume_influencer_reserve_apify(
  p_run uuid, p_influencer uuid, p_kind text, p_actor text, p_estimate numeric, p_external_usd numeric, p_cap numeric
)
returns jsonb
language plpgsql
set search_path = pg_catalog, public
set lock_timeout = '5s'
as $$
declare
  v_account numeric := case when p_external_usd is not null and p_external_usd >= 0 then p_external_usd end;
  v_basis text := case when p_external_usd is not null and p_external_usd >= 0 then 'account' else 'ledger' end;
  v_status text;
  v_reserved numeric;
  v_spend numeric;
  v_committed numeric;
  v_row public.influencer_apify_runs;
  v_parts jsonb;
begin
  if p_estimate is null or p_estimate < 0 then
    return jsonb_build_object('ok', false, 'error', 'bad_estimate');
  end if;
  if p_cap is null or p_cap <= 0 then
    return jsonb_build_object('ok', false, 'error', 'bad_cap');
  end if;
  select status into v_status from public.influencer_runs where id = p_run for update;
  if v_status is distinct from 'running' then
    return jsonb_build_object('ok', false, 'error', 'run_not_running', 'status', v_status);
  end if;
  perform pg_advisory_xact_lock(hashtext('lume_research_budget'));
  select * into v_row from public.influencer_apify_runs
   where run_id = p_run and influencer_id = p_influencer and kind = p_kind;
  if found then
    return jsonb_build_object('ok', true, 'existing', true, 'id', v_row.id, 'status', v_row.status,
      'apify_run_id', v_row.apify_run_id, 'dataset_id', v_row.dataset_id);
  end if;
  v_reserved := public.lume_research_reserved_usd();
  v_spend := public.lume_research_month_spend();
  v_committed := case when v_basis = 'account' then v_account + v_reserved else v_spend end;
  v_parts := jsonb_build_object(
    'basis', v_basis, 'account_usd', v_account, 'reserved_usd', v_reserved, 'month_spend_usd', v_spend,
    'committed_usd', v_committed, 'estimate_usd', p_estimate, 'cap_usd', p_cap);
  if v_committed + p_estimate > p_cap then
    return jsonb_build_object('ok', false, 'error', 'budget_exceeded') || v_parts;
  end if;
  insert into public.influencer_apify_runs (run_id, influencer_id, kind, actor_id, status, estimate_usd, cost_usd)
    values (p_run, p_influencer, p_kind, p_actor, 'pending', p_estimate, p_estimate)
    returning * into v_row;
  return jsonb_build_object('ok', true, 'existing', false, 'id', v_row.id, 'status', 'pending') || v_parts;
end
$$;
revoke all on function public.lume_influencer_reserve_apify(uuid, uuid, text, text, numeric, numeric, numeric) from public, anon, authenticated;
grant execute on function public.lume_influencer_reserve_apify(uuid, uuid, text, text, numeric, numeric, numeric) to service_role;

create or replace function public.lume_influencer_fail_run(p_run uuid, p_error text)
returns jsonb
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_ids text[];
begin
  update public.influencer_runs
     set status = 'failed', error = left(coalesce(p_error, 'failed'), 2000), finished_at = now(), updated_at = now(),
         lease_token = null, lease_until = null
   where id = p_run and status = 'running';
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_running');
  end if;
  with closed as (
    update public.influencer_apify_runs
       set status = 'failed', finished_at = now(), error = left('run failed: ' || coalesce(p_error, ''), 2000)
     where run_id = p_run and status in ('pending', 'running')
    returning apify_run_id
  )
  select coalesce(array_agg(apify_run_id) filter (where apify_run_id is not null), '{}') into v_ids from closed;
  return jsonb_build_object('ok', true, 'abort', to_jsonb(v_ids));
end
$$;
revoke all on function public.lume_influencer_fail_run(uuid, text) from public, anon, authenticated;
grant execute on function public.lume_influencer_fail_run(uuid, text) to service_role;

create or replace function public.lume_influencer_sweep(
  p_stale_minutes integer default 30,
  p_pending_minutes integer default 5,
  p_running_minutes integer default 30,
  p_max_run_hours integer default 6,
  p_awaiting_hours integer default 72
)
returns table (run_id uuid, apify_run_id text, reason text)
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  -- runs whose chain died
  update public.influencer_runs r
     set status = 'failed', error = 'stale: no progress for ' || greatest(p_stale_minutes, 1) || ' minutes',
         finished_at = now(), updated_at = now(), lease_token = null, lease_until = null
   where r.status = 'running'
     and coalesce(r.heartbeat_at, r.created_at) < now() - make_interval(mins => greatest(p_stale_minutes, 1))
     and (r.lease_until is null or r.lease_until < now());
  -- runs past the maximum age (a hung loop that keeps its heartbeat)
  update public.influencer_runs r
     set status = 'failed', error = 'max run age: still running after ' || greatest(p_max_run_hours, 1) || ' hours',
         finished_at = now(), updated_at = now(), lease_token = null, lease_until = null
   where r.status = 'running'
     and coalesce(r.approved_at, r.created_at) < now() - make_interval(hours => greatest(p_max_run_hours, 1));
  -- reactions approvals nobody gave (nothing paid is pending at this point)
  update public.influencer_runs r
     set status = 'cancelled', error = 'expired: the reactions bill waited ' || greatest(p_awaiting_hours, 1) || ' hours without approval',
         finished_at = now(), updated_at = now(), lease_token = null, lease_until = null
   where r.status = 'awaiting_approval'
     and coalesce(r.awaiting_since, r.created_at) < now() - make_interval(hours => greatest(p_awaiting_hours, 1));

  return query
  with closed as (
    update public.influencer_apify_runs a
       set status = 'failed', finished_at = now(),
           error = case
             when ar.status not in ('running', 'awaiting_approval') then 'run ' || ar.status
             when a.status = 'pending' then 'never started: no Apify run id after ' || greatest(p_pending_minutes, 1) || ' minutes (reservation kept as the cost)'
             else 'timed out: running after ' || greatest(p_running_minutes, 1) || ' minutes'
           end
      from public.influencer_runs ar
     where ar.id = a.run_id
       and a.status in ('pending', 'running')
       and (
         ar.status not in ('running', 'awaiting_approval')
         or (a.status = 'pending' and a.apify_run_id is null and a.created_at < now() - make_interval(mins => greatest(p_pending_minutes, 1)))
         or (a.status = 'running' and coalesce(a.started_at, a.created_at) < now() - make_interval(mins => greatest(p_running_minutes, 1)))
       )
    returning a.run_id, a.apify_run_id, a.error
  )
  select c.run_id, c.apify_run_id, c.error from closed c;
end
$$;
revoke all on function public.lume_influencer_sweep(integer, integer, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.lume_influencer_sweep(integer, integer, integer, integer, integer) to service_role;

create or replace function public.lume_influencer_sweep_stale(p_minutes integer default 30)
returns table (run_id uuid, apify_run_id text)
language sql
set search_path = pg_catalog, public
as $$
  select s.run_id, s.apify_run_id from public.lume_influencer_sweep(p_minutes) s
$$;
revoke all on function public.lume_influencer_sweep_stale(integer) from public, anon, authenticated;
grant execute on function public.lume_influencer_sweep_stale(integer) to service_role;
