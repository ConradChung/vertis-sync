-- Job search pipeline, revision 2: fill every order to Leadsfriday's minimum.
--
-- Leadsfriday rejects orders under 500 contacts, so a batch can no longer be
-- "this scrape's rows". The gate now draws from the whole eligible pool in
-- Jobs Final (strict GTM-engineer titles first, then GTM-adjacent, then
-- everything else) until enough companies resolve for a 500-contact order.
-- If the pool runs dry the batch parks as waiting_fill and an hourly cron
-- re-runs the fill as new scrapes land; new scrapes merge into the open batch.
-- See docs/plans/2026-10-09-jobsearch-pipeline-design.md, "Revision 2".

alter table job_batches drop constraint if exists job_batches_status_check;
alter table job_batches add constraint job_batches_status_check
  check (status in ('awaiting_review','skipped','approved','resolving','waiting_fill','ordered',
                    'delivered','ranked','written','discarded','failed','merged'));

alter table job_batches
  add column if not exists lookback_days int  not null default 365,   -- postedAt/added_on window for the pool
  add column if not exists fill_rounds   int  not null default 0,     -- gate passes so far
  add column if not exists force_order   boolean not null default false, -- "Order anyway" below the minimum
  add column if not exists merged_into   uuid references job_batches(id); -- set on status 'merged'

alter table job_batch_companies
  add column if not exists fit_tier int not null default 1;            -- 1 strict GTM, 2 adjacent, 3 everything else

create index if not exists job_batch_companies_domain_idx on job_batch_companies (domain);

-- Hourly: re-run the fill for parked batches. Like pipeline_watchdog() this only
-- POSTs; the puller decides. Secrets come from the vault entries that function
-- already relies on.
create or replace function public.jobsearch_refill_tick() returns void
language plpgsql security definer as $$
declare
  key text;
  url text;
  b record;
begin
  select decrypted_secret into key from vault.decrypted_secrets where name = 'service_role_key';
  select decrypted_secret into url from vault.decrypted_secrets where name = 'project_url';
  if key is null or url is null then return; end if;

  for b in
    select id from job_batches
    where status = 'waiting_fill'
      and updated_at < now() - interval '50 minutes'
  loop
    perform net.http_post(
      url     := url || '/functions/v1/jobsearch-puller',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'Authorization', 'Bearer ' || key,
                   'apikey', key
                 ),
      body    := jsonb_build_object('batch_id', b.id, 'phase', 'refill')
    );
  end loop;
end $$;

select cron.unschedule('jobsearch-refill') where exists (
  select 1 from cron.job where jobname = 'jobsearch-refill');
select cron.schedule('jobsearch-refill', '17 * * * *', 'select public.jobsearch_refill_tick()');
