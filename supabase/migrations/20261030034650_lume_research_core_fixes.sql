-- Research core fixes (follows lume_research_core).
--
-- 1. Budget basis. The cap (LUME_RESEARCH_APIFY_CAP_USD, default 29) is the
--    Apify plan's account-wide monthly cap, and Apify's account usage already
--    includes this layer's finished runs. So:
--      committed = account usage + reservations
--      reservations = estimate_usd of our crawls still pending/running
--                     (no final cost yet; a finished run is never counted twice)
--    When account usage is unreadable (p_external_usd null or negative), the
--    fallback is our own month-to-date sum (finished costs + reserved
--    estimates), never $0. Refused when committed + this run's estimate > cap.
--    The reply carries basis ('account' | 'ledger') and the parts.
-- 2. lume_research_fail_stale_crawls(minutes): crawls pending/running for longer
--    than that are failed ("stale: no result after N minutes"), which frees the
--    company (one active crawl per company) and drops the reservation. The
--    swept row keeps its estimate as cost_usd: the conservative figure for the
--    ledger fallback. company-research calls it on every invocation; P3's cron
--    can too.

create or replace function public.lume_research_reserved_usd()
returns numeric
language sql
stable
set search_path = pg_catalog, public
as $$
  select coalesce(sum(estimate_usd), 0)::numeric
    from public.company_crawls
   where status in ('pending', 'running')
$$;
revoke all on function public.lume_research_reserved_usd() from public, anon, authenticated;
grant execute on function public.lume_research_reserved_usd() to service_role;

create or replace function public.lume_research_reserve_crawl(
  p_company uuid, p_start_url text, p_estimate numeric, p_external_usd numeric, p_cap numeric
)
returns jsonb
language plpgsql
set search_path = pg_catalog, public
set lock_timeout = '5s'
as $$
declare
  v_account numeric := case when p_external_usd is not null and p_external_usd >= 0 then p_external_usd end;
  v_basis text := case when p_external_usd is not null and p_external_usd >= 0 then 'account' else 'ledger' end;
  v_reserved numeric;
  v_spend numeric;
  v_committed numeric;
  v_id uuid;
  v_parts jsonb;
begin
  if p_estimate is null or p_estimate < 0 then
    return jsonb_build_object('ok', false, 'error', 'bad_estimate');
  end if;
  if p_cap is null or p_cap <= 0 then
    return jsonb_build_object('ok', false, 'error', 'bad_cap');
  end if;
  -- One budget decision at a time, so two concurrent runs cannot both fit.
  perform pg_advisory_xact_lock(hashtext('lume_research_budget'));
  v_reserved := public.lume_research_reserved_usd();
  v_spend := public.lume_research_month_spend();
  v_committed := case when v_basis = 'account' then v_account + v_reserved else v_spend end;
  v_parts := jsonb_build_object(
    'basis', v_basis, 'account_usd', v_account, 'reserved_usd', v_reserved, 'month_spend_usd', v_spend,
    'committed_usd', v_committed, 'estimate_usd', p_estimate, 'cap_usd', p_cap);
  if v_committed + p_estimate > p_cap then
    return jsonb_build_object('ok', false, 'error', 'budget_exceeded') || v_parts;
  end if;
  begin
    insert into public.company_crawls (company_id, status, start_url, estimate_usd, cost_usd)
      values (p_company, 'pending', p_start_url, p_estimate, p_estimate)
      returning id into v_id;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'crawl_in_progress');
  end;
  return jsonb_build_object('ok', true, 'crawl_id', v_id) || v_parts;
end
$$;
revoke all on function public.lume_research_reserve_crawl(uuid, text, numeric, numeric, numeric) from public, anon, authenticated;
grant execute on function public.lume_research_reserve_crawl(uuid, text, numeric, numeric, numeric) to service_role;

create or replace function public.lume_research_fail_stale_crawls(p_minutes integer default 15)
returns integer
language sql
set search_path = pg_catalog, public
as $$
  with swept as (
    update public.company_crawls
       set status = 'failed',
           error = 'stale: no result after ' || greatest(p_minutes, 1) || ' minutes',
           finished_at = now()
     where status in ('pending', 'running')
       and created_at < now() - make_interval(mins => greatest(p_minutes, 1))
    returning 1
  )
  select count(*)::int from swept
$$;
revoke all on function public.lume_research_fail_stale_crawls(integer) from public, anon, authenticated;
grant execute on function public.lume_research_fail_stale_crawls(integer) to service_role;
