-- Job search pipeline: weekly GTM-engineer scrape -> ranked contacts -> gtm tab.
-- Three tables plus a private Storage bucket. The pipeline, its gates and the
-- claim columns are described in docs/plans/2026-10-09-jobsearch-pipeline-design.md.
--
-- review_status / write_status / watchdog_status are claim slots: a button tap
-- PATCHes ...&<slot>=eq.awaiting -> claimed and acts only if a row came back,
-- the same pattern validation_jobs uses for finder_status and watchdog_status.
-- updated_at is maintained by the trigger below and is the heartbeat the
-- watchdog reads; every puller phase PATCHes the row as it works.

create table if not exists job_batches (
  id              uuid primary key default gen_random_uuid(),
  batch_date      date not null unique,            -- the Monday the scrape ran; equals Jobs Final.added_on
  status          text not null default 'awaiting_review'
                  check (status in ('awaiting_review','skipped','approved','resolving','ordered',
                                    'delivered','ranked','written','discarded','failed')),
  review_status   text not null default 'awaiting' check (review_status in ('awaiting','claimed')),
  write_status    text not null default 'idle'     check (write_status in ('idle','awaiting','claimed')),
  watchdog_status text not null default 'idle'     check (watchdog_status in ('idle','awaiting','claimed')),
  watchdog_notified_at timestamptz,
  companies_added  int not null default 0,          -- rows the scrape appended
  companies_pulled int not null default 0,          -- rows that passed the gate
  companies_unresolved int not null default 0,      -- websites Apollo could not map to an org id
  apollo_url       text,
  leadsfriday_order_id bigint,
  leadsfriday_status   text,                        -- pending|in_progress|delivered|cancelled as reported
  leadsfriday_download_url text,
  result_storage_path  text,                        -- leadsfriday-results/<batch_id>.csv
  contacts_total   int not null default 0,
  contacts_kept    int not null default 0,
  error            text,
  telegram_message_id bigint,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Reuses update_updated_at_column() from 20260322000001.
drop trigger if exists set_job_batches_updated_at on job_batches;
create trigger set_job_batches_updated_at
  before update on job_batches
  for each row execute function update_updated_at_column();

create table if not exists job_batch_companies (
  id            uuid primary key default gen_random_uuid(),
  batch_id      uuid not null references job_batches(id) on delete cascade,
  company_name  text not null,
  website       text,
  domain        text,                                -- normalized: no scheme, no www., no path, lowercase
  job_title     text,
  job_link      text,
  job_poster_name text, job_poster_title text, job_poster_url text,
  salary_text   text, posted_at text, employees int, industries text, location text,
  -- Carried from the Jobs Final row so the gtm writer never re-reads the sheet.
  other_titles  text, n_postings text, funding_stage text, yc_batch text,
  apollo_org_id text,
  resolve_status text not null default 'pending'
                 check (resolve_status in ('pending','resolved','unresolved','excluded')),
  exclude_reason text,                               -- 'not_a_right_fit' | 'already_in_gtm' | 'title_mismatch' | 'batch_cap'
  created_at    timestamptz not null default now(),
  unique (batch_id, domain)
);

create table if not exists job_contacts (
  id            uuid primary key default gen_random_uuid(),
  batch_id      uuid not null references job_batches(id) on delete cascade,
  company_id    uuid references job_batch_companies(id) on delete set null,
  company_name  text not null,
  domain        text,
  first_name    text, last_name  text, title text, email text, linkedin_url text,
  seniority     text, department text, location text, corporate_phone text,
  role          text not null check (role in ('job_poster','recruiter','sales_leader','founder','other')),
  rank          int  not null,                        -- 1 = best within the company
  kept          boolean not null default false,       -- top N per company
  raw           jsonb,                                -- the full Leadsfriday row
  created_at    timestamptz not null default now(),
  unique (batch_id, email)                            -- blank emails are stored as NULL and never collide
);
create index if not exists job_contacts_batch_company_rank_idx on job_contacts (batch_id, company_name, rank);
create index if not exists job_batches_active_idx on job_batches (status)
  where status not in ('written','discarded','skipped','failed');

-- Private bucket for the Leadsfriday CSV and the rows written to gtm.
-- validation-results was created in the dashboard; this is the same thing, tracked.
insert into storage.buckets (id, name, public)
values ('leadsfriday-results', 'leadsfriday-results', false)
on conflict (id) do nothing;
