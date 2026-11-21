-- company_check scope / property type (migration *_lume_company_check_scope_property.sql).
-- Run via execute_sql: `begin;` + this file. It never commits: the final
-- RAISE aborts the transaction (so the lead_bank update below is rolled back)
-- and its message carries {failed, total, rows}. Expect failed = 0.
-- Uses job 16f26ffc (Kaspen Main), which has lead_bank rows in queued/active/skipped.
do $t$
declare
  j uuid := '16f26ffc-f8e5-47a5-9e1b-7532f61dad75';
  icp text := 'pgtap test icp text';
  pa jsonb; ps jsonb; ra public.company_check_runs; rs public.company_check_runs; ra2 public.company_check_runs;
  sa jsonb; ss jsonb; out jsonb := '[]'; ok boolean; n int; m int;
  bank_emails int;
begin
  pa := public.company_check_plan(j, icp);
  ps := public.company_check_plan(j, icp, 'sending');
  out := out || jsonb_build_object('t','plan default scope = all', 'ok', pa->>'scope' = 'all');
  out := out || jsonb_build_object('t','sending leads < all leads', 'ok', (ps->>'valid_leads')::int < (pa->>'valid_leads')::int, 'all', pa->'valid_leads', 'sending', ps->'valid_leads');
  select count(distinct lower(btrim(email))) into bank_emails from lead_bank where source_job_id = j and state in ('queued','active');
  out := out || jsonb_build_object('t','sending leads <= bank queued/active emails', 'ok', (ps->>'valid_leads')::int <= bank_emails, 'bank', bank_emails);
  out := out || jsonb_build_object('t','sending companies <= all companies', 'ok', (ps->>'companies')::int <= (pa->>'companies')::int, 'all', pa->'companies', 'sending', ps->'companies');
  begin
    perform public.company_check_plan(j, icp, 'bogus'); ok := false;
  exception when others then ok := sqlerrm like '%scope must be%';
  end;
  out := out || jsonb_build_object('t','bad scope raises', 'ok', ok);
  ra := public.company_check_open_run(j, icp);
  rs := public.company_check_open_run(j, icp, 'sending');
  ra2 := public.company_check_open_run(j, icp, 'all');
  out := out || jsonb_build_object('t','all and sending runs are different rows', 'ok', ra.id <> rs.id and ra.scope = 'all' and rs.scope = 'sending');
  out := out || jsonb_build_object('t','open_run is idempotent per scope', 'ok', ra.id = ra2.id);
  sa := public.company_check_seed(ra.id);
  ss := public.company_check_seed(rs.id);
  select companies_total into n from company_check_runs where id = rs.id;
  out := out || jsonb_build_object('t','sending seed = plan companies', 'ok', n = (ps->>'companies')::int, 'n', n);
  select companies_total into m from company_check_runs where id = ra.id;
  out := out || jsonb_build_object('t','all seed = plan companies', 'ok', m = (pa->>'companies')::int, 'n', m);
  select coalesce(sum(leads),0) into n from company_check_items where run_id = rs.id;
  out := out || jsonb_build_object('t','sending seed leads = plan leads with a company', 'ok', n = (ps->>'valid_leads')::int - (ps->>'leads_without_company')::int, 'n', n);
  -- a pulled lead leaves the scope: its company's lead count drops / unchecked company dropped on reseed
  update lead_bank set state = 'skipped' where source_job_id = j and state in ('queued','active');
  ss := public.company_check_seed(rs.id);
  select count(*) into n from company_check_items where run_id = rs.id;
  out := out || jsonb_build_object('t','reseed after all pulled drops unchecked companies', 'ok', n = 0, 'n', n);
  -- a checked company keeps its row with 0 leads
  insert into company_check_items (run_id, company_key, leads, status) values (rs.id, 'pgtap.example', 3, 'done');
  insert into company_checks (company_key, icp_key, what_it_does, icp_fit, confidence, property_type, doors) values ('pgtap.example', rs.icp_key, 'x', 'not_fit', 'low', 'multifamily', 1200);
  ss := public.company_check_seed(rs.id);
  select leads into n from company_check_items where run_id = rs.id and company_key = 'pgtap.example';
  out := out || jsonb_build_object('t','checked company out of scope kept with 0 leads', 'ok', n = 0);
  update company_check_items set leads = 3 where run_id = rs.id and company_key = 'pgtap.example';
  ss := public.company_check_summary(rs.id);
  out := out || jsonb_build_object('t','summary by type', 'ok', ss->'companies_by_type' = '{"multifamily":1}' and ss->'leads_by_type' = '{"multifamily":3}', 's', ss);
  select count(*) into n from company_check_results where run_id = rs.id and doors = 1200 and property_type = 'multifamily' and scope = 'sending';
  out := out || jsonb_build_object('t','view carries type/doors/scope', 'ok', n = 1);
  begin
    insert into company_checks (company_key, icp_key, what_it_does, icp_fit, confidence, doors) values ('neg.example', rs.icp_key, 'x', 'fit', 'low', -1); ok := false;
  exception when check_violation then ok := true;
  end;
  out := out || jsonb_build_object('t','doors >= 0', 'ok', ok);
  begin
    insert into company_checks (company_key, icp_key, what_it_does, icp_fit, confidence, property_type) values ('pt.example', rs.icp_key, 'x', 'fit', 'low', 'industrial'); ok := false;
  exception when check_violation then ok := true;
  end;
  out := out || jsonb_build_object('t','property_type enum', 'ok', ok);
  select count(*) into n from pg_proc where proname in ('company_check_plan','company_check_open_run');
  out := out || jsonb_build_object('t','no overloads left', 'ok', n = 2);
  select count(*) into n from information_schema.routine_privileges where routine_name in ('company_check_plan','company_check_open_run','company_check_scoped_rows') and grantee in ('anon','authenticated','PUBLIC');
  out := out || jsonb_build_object('t','no anon/authenticated grants', 'ok', n = 0);
  raise exception 'TAP %', (select jsonb_build_object('failed', (select count(*) from jsonb_array_elements(out) e where not (e->>'ok')::boolean), 'total', jsonb_array_length(out), 'rows', out));
end $t$;
