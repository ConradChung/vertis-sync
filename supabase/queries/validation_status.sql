-- ============================================================================
-- Validation run status — paste any single block into the Supabase SQL editor.
--
-- Row status meanings:
--   pending   not checked yet
--   valid     MailTester said "Accepted" — the only thing that reaches the CSV
--   invalid   Rejected / Catch-All / No MX — a real negative verdict
--   error     either (a) inconclusive: SPAM Block / Timeout / Limited / MX Error
--             / HTTP error, queued for retry, or (b) parked by an operator halt
--   no_email  no address to check (the finder came up empty)
-- ============================================================================


-- ─── 1. RAW MAILTESTER RESPONSE — exactly what the API returned, per lead ──
-- `mailtester_response` is the API body verbatim. The pipeline adds two
-- bookkeeping keys (`inconclusive`, `attempts`) to rows queued for retry, so
-- those are stripped here and surfaced separately as retry_attempts.
--
-- Field reference (https://mailtester.ninja/api/):
--   code        ok = valid | ko = invalid | mb = unverifiable | -- = key problem
--   message     Accepted | Rejected | Catch-All | No MX | MX Error
--               | Timeout | SPAM Block | Limited | Invalid Key | Disabled Key
--   mx          the mail host it talked to (blank on some cached answers)
--   connections simultaneous connections your plan allows
--   limit       daily quota — 0 means the KEY was refused, not a bad address
--   rate        undocumented; climbs with recent usage
--
-- A row where code = '--' or limit = 0 is a key failure returned as HTTP 200.
-- It says nothing about the address. If you see any, stop the run.
select
  r.email                                             as row_email,
  r.status                                            as filed_as,
  r.processed_at,
  (r.validation_result - 'inconclusive' - 'attempts') as mailtester_response,
  r.validation_result->>'email'                       as "email",
  r.validation_result->>'user'                        as "user",
  r.validation_result->>'domain'                      as "domain",
  r.validation_result->>'mx'                          as "mx",
  r.validation_result->>'code'                        as "code",
  r.validation_result->>'message'                     as "message",
  (r.validation_result->>'connections')::int          as "connections",
  (r.validation_result->>'limit')::int                as "limit",
  (r.validation_result->>'rate')::int                 as "rate",
  (r.validation_result->>'attempts')::int             as retry_attempts
from validation_rows r
where r.job_id = (select id from validation_jobs order by created_at desc limit 1)
  and r.validation_result ? 'code'   -- a real API body; excludes HTTP-error
                                     -- stubs and operator halt markers
-- and r.status = 'valid'            -- uncomment to inspect one bucket
order by r.processed_at desc
limit 200;


-- ─── 2. OVERVIEW — every recent run, live progress, pace and ETA ────────────
-- Pace is the median gap over the last 200 rows, so a restart gap or an
-- overnight stall doesn't drag the ETA off. idle_for is the stall signal:
-- anything over ~5 min on a "processing" job means the worker chain broke.
with pace as (
  select j.id as job_id,
         round((60.0 / nullif(
           percentile_cont(0.5) within group (order by extract(epoch from g.gap)), 0))::numeric, 1)
         as rows_per_min
  from validation_jobs j
  cross join lateral (
    select t.processed_at - lag(t.processed_at) over (order by t.processed_at) as gap
    from (select processed_at
          from validation_rows
          where job_id = j.id and processed_at is not null
          order by processed_at desc
          limit 200) t
  ) g
  where g.gap is not null and g.gap < interval '60 seconds'
  group by j.id
)
select
  left(j.id::text, 8)                            as job,
  j.filename,
  j.status                                       as job_status,
  j.total_rows,
  count(*) filter (where r.status = 'pending')   as pending,
  count(*) filter (where r.status = 'valid')     as valid,
  count(*) filter (where r.status = 'invalid')   as invalid,
  count(*) filter (where r.status = 'error'
                     and r.validation_result ? 'inconclusive')       as inconclusive,
  count(*) filter (where r.status = 'error'
                     and not (r.validation_result ? 'inconclusive')) as parked,
  count(*) filter (where r.status = 'no_email')  as no_email,
  round(100.0 * count(*) filter (where r.status = 'valid')
        / nullif(count(*) filter (where r.status in ('valid','invalid')), 0), 1) as valid_pct,
  p.rows_per_min,
  (count(*) filter (where r.status = 'pending')
     / nullif(p.rows_per_min, 0) * interval '1 minute')              as eta,
  now() - max(r.processed_at)                    as idle_for,
  j.created_at
from validation_jobs j
join validation_rows r on r.job_id = j.id
left join pace p on p.job_id = j.id
where j.created_at > now() - interval '14 days'
group by j.id, j.filename, j.status, j.total_rows, j.created_at, p.rows_per_min
order by j.created_at desc;


-- ─── 3. VERDICT MIX — what MailTester said vs how the pipeline filed it ────
-- Sanity check the classifier: nothing inconclusive should ever be filed as
-- invalid, or you are discarding addresses that were never actually tested.
select
  coalesce(r.validation_result->>'message',
           r.validation_result->>'error',
           '(not yet checked)')                  as mailtester_says,
  r.status                                       as filed_as,
  count(*)                                       as leads,
  round(100.0 * count(*) / sum(count(*)) over (), 1) as pct
from validation_rows r
where r.job_id = (select id from validation_jobs order by created_at desc limit 1)
  and r.status <> 'no_email'
group by 1, 2
order by leads desc;


-- ─── 4. LEAD-LEVEL — individual leads and their verdict ────────────────────
-- Change the status filter to inspect a different bucket:
--   'valid'   the leads you'll actually mail
--   'invalid' what got dropped (check Catch-All volume here)
--   'error'   inconclusive, awaiting retry
select
  r.email,
  r.row_data->>'First Name'       as first_name,
  r.row_data->>'Last Name'        as last_name,
  r.row_data->>'Title'            as title,
  r.row_data->>'Company Name'     as company,
  r.row_data->>'City'             as city,
  r.status                        as verdict,
  r.validation_result->>'message' as mailtester_says,
  nullif(r.validation_result->>'mx', '') as mx,
  r.processed_at
from validation_rows r
where r.job_id = (select id from validation_jobs order by created_at desc limit 1)
  and r.status = 'valid'          -- <-- change bucket here
order by r.processed_at desc
limit 200;


-- ─── 5. WHY LEADS WERE DROPPED — the invalid bucket, by reason ─────────────
-- Catch-All is the one to watch. It is not "bad address", it is "this domain
-- accepts everything so nobody can tell". Excluding it is a deliverability
-- choice, not a correctness one.
select
  r.validation_result->>'message'  as reason,
  count(*)                         as leads,
  round(100.0 * count(*) / sum(count(*)) over (), 1) as pct_of_dropped,
  count(distinct r.validation_result->>'domain')     as distinct_domains
from validation_rows r
where r.job_id = (select id from validation_jobs order by created_at desc limit 1)
  and r.status = 'invalid'
group by 1
order by leads desc;


-- ─── 6. STALL CHECK — is anything wedged right now? ────────────────────────
-- A "processing" job whose last row landed more than ~5 minutes ago has a
-- broken worker chain. Recovery is a single POST to the edge function:
--   POST /functions/v1/email-validator   {"job_id": "<id>"}
-- Do NOT fire that twice — two concurrent workers exceed the MailTester rate
-- limit (11 req / 10s) and everything comes back HTTP 429.
select
  left(j.id::text, 8)          as job,
  j.filename,
  j.status,
  max(r.processed_at)          as last_row_at,
  now() - max(r.processed_at)  as idle_for,
  count(*) filter (where r.status = 'pending') as still_pending,
  case
    when j.status <> 'processing'                           then 'not running'
    when now() - max(r.processed_at) > interval '5 minutes' then '>>> STALLED — re-invoke once'
    else 'healthy'
  end                          as verdict
from validation_jobs j
join validation_rows r on r.job_id = j.id
where j.status in ('pending', 'processing')
group by j.id, j.filename, j.status
order by idle_for desc;
