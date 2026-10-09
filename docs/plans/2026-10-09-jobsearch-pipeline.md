# Job Search Pipeline Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Turn each Monday's `Jobs Final` additions into ranked decision-maker contacts in the `gtm` tab, gated twice by the owner in Telegram (and the dashboard), on the NorthStar infrastructure the validation pipeline already uses.

**Architecture:** Three new Supabase tables (`job_batches`, `job_batch_companies`, `job_contacts`) hold state and the atomic claim slots. Three new Deno edge functions (`jobsearch-notify`, `jobsearch-puller`, `jobsearch-sheet-writer`) do the work; `jobsearch-puller` is a phase worker that self-invokes under the 150 s wall clock, like `hnwi-pipeline-orchestrator`. `telegram-inbox` gains `jobs_*` callback handlers with the same answer → claim → edit → invoke order its existing handlers use, and `pipeline-watchdog` gains a notify-only scan of `job_batches`. The dashboard mirrors the buttons through two Next.js routes that run the same conditional PATCHes.

**Tech Stack:** Deno edge functions (raw PostgREST, no npm client), Google Sheets REST v4 with a service-account JWT signed by WebCrypto RS256, Apollo `POST /v1/accounts`, Leadsfriday Apollo-scraper API, Telegram Bot API, Next.js 16 App Router, Deno `std/assert` for unit tests (run with `npx -y deno test`; Deno is not installed globally, npx fetches 2.9.x).

Design reference: `docs/plans/2026-10-09-jobsearch-pipeline-design.md`

**Conventions carried over from the repo**
- Never hardcode a sheet column index. Read row 1 and look names up.
- Every multi-row PostgREST GET states its own `limit` (unbounded GETs cap at 1000 silently).
- Every state transition is `PATCH …?id=eq.<id>&<slot>=eq.<expected>` with `return=representation`; zero rows → return.
- Workers PATCH the parent row as they go so `updated_at` is the heartbeat the watchdog reads.
- New secrets go in `supabase secrets set`, never in the repo.

---

## Task 1: Migration

**Files:**
- Create: `supabase/migrations/20261009120000_jobsearch_pipeline.sql`

**Step 1: Write the migration**

```sql
-- Job search pipeline: weekly GTM-engineer scrape -> ranked contacts -> gtm tab.
-- Three tables plus a private Storage bucket. See
-- docs/plans/2026-10-09-jobsearch-pipeline-design.md.

create table if not exists job_batches (
  id              uuid primary key default gen_random_uuid(),
  batch_date      date not null unique,
  status          text not null default 'awaiting_review'
                  check (status in ('awaiting_review','skipped','approved','resolving','ordered',
                                    'delivered','ranked','written','discarded','failed')),
  review_status   text not null default 'awaiting' check (review_status in ('awaiting','claimed')),
  write_status    text not null default 'idle'     check (write_status in ('idle','awaiting','claimed')),
  watchdog_status text not null default 'idle'     check (watchdog_status in ('idle','awaiting','claimed')),
  watchdog_notified_at timestamptz,
  companies_added  int not null default 0,
  companies_pulled int not null default 0,
  companies_unresolved int not null default 0,
  apollo_url       text,
  leadsfriday_order_id bigint,
  leadsfriday_status   text,
  leadsfriday_download_url text,
  result_storage_path  text,
  contacts_total   int not null default 0,
  contacts_kept    int not null default 0,
  error            text,
  telegram_message_id bigint,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

drop trigger if exists set_job_batches_updated_at on job_batches;
create trigger set_job_batches_updated_at
  before update on job_batches
  for each row execute function update_updated_at_column();

create table if not exists job_batch_companies (
  id            uuid primary key default gen_random_uuid(),
  batch_id      uuid not null references job_batches(id) on delete cascade,
  company_name  text not null,
  website       text,
  domain        text,
  job_title     text,
  job_link      text,
  job_poster_name text, job_poster_title text, job_poster_url text,
  salary_text   text, posted_at text, employees int, industries text, location text,
  other_titles  text, n_postings text, funding_stage text, yc_batch text,
  apollo_org_id text,
  resolve_status text not null default 'pending'
                 check (resolve_status in ('pending','resolved','unresolved','excluded')),
  exclude_reason text,
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
  rank          int  not null,
  kept          boolean not null default false,
  raw           jsonb,
  created_at    timestamptz not null default now(),
  unique (batch_id, email)
);
create index if not exists job_contacts_batch_company_rank_idx on job_contacts (batch_id, company_name, rank);
create index if not exists job_batches_active_idx on job_batches (status)
  where status not in ('written','discarded','skipped','failed');

insert into storage.buckets (id, name, public)
values ('leadsfriday-results', 'leadsfriday-results', false)
on conflict (id) do nothing;
```

**Step 2: Apply it**

Docker is not available on this machine, so `supabase db reset` cannot run locally. Apply with the Supabase MCP `apply_migration` tool against project `rcfrumrbauwvyzfebxck`, `name: jobsearch_pipeline`. The migration is purely additive.

**Step 3: Verify**

`select table_name, count(*) from information_schema.columns where table_name in ('job_batches','job_batch_companies','job_contacts') group by 1;` → 25 / 25 / 20. `select id from storage.buckets where id='leadsfriday-results';` → one row. `select tgname from pg_trigger where tgrelid='job_batches'::regclass;` includes `set_job_batches_updated_at`.

**Step 4: Commit**

```bash
git add supabase/migrations/20261009120000_jobsearch_pipeline.sql
git commit -m "feat(jobsearch): job_batches, job_batch_companies, job_contacts + leadsfriday-results bucket"
```

---

## Task 2: Pure helpers with tests (`_shared/jobsearch/pure.ts`)

**Files:**
- Create: `supabase/functions/_shared/jobsearch/pure.ts`
- Test: `supabase/functions/_shared/jobsearch/pure_test.ts`

**Step 1: Write the failing tests** — one `Deno.test` per behaviour:

- `isGtmTitle`: matches `Founding GTM Engineer`, `Go-To-Market Engineer`, `Growth Engineer`, `GTM Ops Lead`, `RevOps Engineer`, `Sales Systems Engineer`, `Forward Deployed Growth`; rejects `Account Executive`, `Software Engineer`.
- `normalizeCompanyName('The Trunk Tools, Inc.') === 'trunk tools'`; `normalizeCompanyName('Peec AI') === 'peec ai'`.
- `normalizeDomain('https://www.trunktools.com/careers?x=1') === 'trunktools.com'`; `normalizeDomain('') === ''`.
- `assignRole`: job-poster name beats everything; `Head of Talent` → recruiter; `CRO` → sales_leader; `Co-Founder & CEO` → founder; `Software Engineer` → other.
- `rankContacts`: within one company a founder with email ranks above a founder without; sales_leader above founder; `kept` true only for rank ≤ 5 of 7.
- `buildApolloUrl(['a','b'])` contains `organizationIds%5B%5D=a&organizationIds%5B%5D=b` and all seven `personSeniorities%5B%5D` values and four `personDepartmentOrSubdepartments%5B%5D` values; throws on > 60 ids.
- `parseCsv('a,b\n"x, y",2\n')` → headers `[a,b]`, one row `['x, y','2']`.
- `mapLeadsfridayRow` with Apollo-style headers (`First Name, Last Name, Title, Email, Person Linkedin Url, Company, Website, Seniority, Departments, City, State, Corporate Phone`) fills every `job_contacts` field; blank email → `null`.
- `headerIndex(['companyName','title'], 'title') === 1`; missing header throws naming it.

**Step 2: Run** `npx -y deno test supabase/functions/_shared/jobsearch/` → FAIL (module not found).

**Step 3: Implement `pure.ts`** with exactly these exports: `GTM_TITLE_RE`, `isGtmTitle`, `normalizeCompanyName`, `normalizeDomain`, `headerIndex`, `rowToRecord`, `parseCsvRow` (slice-based, copied from `telegram-inbox`), `parseCsv`, `assignRole`, `ROLE_PRIORITY`, `SENIORITY_PRIORITY`, `rankContacts`, `buildApolloUrl`, `APOLLO_MAX_ORGS = 60`, `mapLeadsfridayRow`, `LEADSFRIDAY_COLUMNS` (the documented mapping table), `csvEscape`, `toCsv`.

**Step 4: Run** the tests → all PASS.

**Step 5: Commit** `feat(jobsearch): pure helpers (title regex, normalization, roles, Apollo URL, CSV) with tests`

---

## Task 3: Google Sheets client (`_shared/jobsearch/sheets.ts`)

**Files:**
- Create: `supabase/functions/_shared/jobsearch/sheets.ts`
- Test: `supabase/functions/_shared/jobsearch/sheets_test.ts` (the pure parts only: PEM → DER, base64url, JWT claim shape)

**Step 1: Tests** — `pemToDer` strips header/footer and decodes; `base64url` has no `=`, `+`, `/`; `buildJwtClaims(email, now)` has `iss`, `scope = https://www.googleapis.com/auth/spreadsheets`, `aud = https://oauth2.googleapis.com/token`, `exp = iat + 3600`.

**Step 2: Run** → FAIL.

**Step 3: Implement.** `getAccessToken(serviceAccountJson)`: parse JSON, import the `private_key` with `crypto.subtle.importKey('pkcs8', …, {name:'RSASSA-PKCS1-v1_5', hash:'SHA-256'}, false, ['sign'])`, sign `base64url(header).base64url(claims)`, POST `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=…` to the token endpoint, return `access_token`. Cache in a module-level variable until 60 s before expiry. `readRange(sheetId, rangeA1)` → `string[][]`. `appendRows(sheetId, rangeA1, rows)` → `POST …/values/{range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`. All errors throw with the Google error message so the puller can put it in `job_batches.error`.

**Step 4: Run** → PASS. **Step 5: Commit** `feat(jobsearch): Google Sheets REST client with service-account JWT`

---

## Task 4: `jobsearch-notify`

**Files:**
- Create: `supabase/functions/jobsearch-notify/index.ts`

Steps: copy `supabaseRequest` and `tg` from `telegram-inbox`. `POST {batch_id}` → 400 if missing, 404 if no batch. Build the text per the design (`🧭 Job scrape — Mon 12 Oct`, count, instruction, sheet link to `#gid=935519386`), keyboard `[Reviewed, pull contacts] jobs_pull:<id>` / `[Skip this week] jobs_skip:<id>`. If `telegram_message_id` is set → `editMessageText`, else `sendMessage` and PATCH `telegram_message_id`. Return `{ok:true, message_id}`. Only send the keyboard while `status = awaiting_review`; for any other status edit/send the text without buttons so a late retry cannot re-arm a decided gate.

Verify: `npx -y deno check supabase/functions/jobsearch-notify/index.ts` passes. Commit `feat(jobsearch): jobsearch-notify sends the Gate 1 Telegram prompt`.

---

## Task 5: `jobsearch-puller`

**Files:**
- Create: `supabase/functions/jobsearch-puller/index.ts`

**Step 1: Skeleton.** Payload `{batch_id, phase?}`. `Deno.serve` validates, returns 200 immediately, runs `run()` under `EdgeRuntime.waitUntil` (the orchestrator pattern). Failure path: PATCH `status='failed', error`, Telegram `❌ Job batch <date> failed at <phase>: <message>`.

**Step 2: Phase dispatch.** `phaseFor(status)`: `approved→gate`, `resolving→resolve`, `ordered→poll`, `delivered→rank`; anything else logs and exits (`ranked`, `written`, terminal statuses are not the puller's business). Explicit `payload.phase` wins when present but is still checked against status so a stale self-invoke after a watchdog Resume cannot run two phases at once.

**Step 3: `gate`.**
1. Claim `status=eq.approved → resolving` (zero rows → exit).
2. `readRange(sheet, "'Jobs Final'!A1:ZZ")`; headers = row 0; `headerIndex` for `companyName,title,status,companyWebsite,link,jobPosterName,jobPosterTitle,jobPosterProfileUrl,salaryText,postedAt,companyEmployeesCount,industries,location,other_titles,n_postings,fundingStage,ycBatch,added_on`.
3. Filter `added_on === batch_date`. For each: `exclude_reason = not_a_right_fit` if status is `Not a Right Fit`; `title_mismatch` if `!isGtmTitle(title)`.
4. `readRange(sheet, "gtm!A1:ZZ")`, collect normalized `company` and `domain` sets → `already_in_gtm`.
5. Dedupe by domain within the batch (first row wins; the `unique(batch_id, domain)` constraint would reject the second anyway). Insert all rows in one POST; `resolve_status = excluded` where a reason exists, else `pending`.
6. PATCH `companies_pulled = pending count`. Self-invoke `resolve`.

**Step 4: `resolve`.** GET up to 20 `pending` companies. For each: `POST https://api.apollo.io/api/v1/accounts` with `x-api-key`, body `{name, domain}`; `organization_id` from `account.organization_id ?? account.organization?.id`. 401/403 → throw `Apollo rejected APOLLO_API_KEY (<status>)` (hard fail). Other non-2xx or missing id → `unresolved`. Resolved → PATCH `apollo_org_id, resolve_status='resolved'`. Heartbeat PATCH after the loop. If any `pending` remain → self-invoke `resolve`; else count resolved, if 0 → fail `no companies to order`; take first 60 (rest → `unresolved`, `exclude_reason='batch_cap'`), `buildApolloUrl`, PATCH `apollo_url, companies_unresolved`, self-invoke `order`.

**Step 5: `order`.** Claim `status=eq.resolving&leadsfriday_order_id=is.null → ordered`. Multipart POST to `${LEADSFRIDAY_BASE}/api/export-apollo/` with `search_url, results_file_name=jobsearch-<batch_date>.csv, contact_count=max(50, resolved*15), verify_emails=yes, note`. 403 → fail `insufficient credits`; 401 → fail naming `LEADSFRIDAY_API_TOKEN`; other non-2xx → fail with body. Store `leadsfriday_order_id, leadsfriday_status`. Self-invoke `poll`.

**Step 6: `poll`.** Loop while `Date.now() - start < 110_000`: GET `/api/export-apollo/<id>/`; PATCH `leadsfriday_status` (heartbeat). `delivered` → fetch `download_url` (follow redirects), `PUT /storage/v1/object/leadsfriday-results/<batch_id>.csv` with `x-upsert: true`, PATCH `result_storage_path, leadsfriday_download_url, status='delivered'`, self-invoke `rank`, return. `cancelled` → fail. Otherwise sleep 60 s (or the remaining budget) and continue; on budget exhaustion self-invoke `poll`. If `now - updated_at_of_order > 6 h` → fail `Leadsfriday did not deliver within 6 hours`. The order time is `job_batches.updated_at` captured when `ordered` was set; store it in the self-invoke payload as `ordered_at` so the clock survives heartbeats.

**Step 7: `rank`.** Download the Storage CSV, `parseCsv`, `mapLeadsfridayRow` each row (keep the full record in `raw`). Load the batch's companies; join by `normalizeDomain(website)` then `normalizeCompanyName(company)`. `assignRole(title, firstName, lastName, company?.job_poster_name)`. `rankContacts` per company. Insert `job_contacts` in batches of 200 with `Prefer: resolution=ignore-duplicates` (re-running rank after a partial insert is safe). PATCH `contacts_total, contacts_kept, status='ranked', write_status='awaiting'`. Send Gate 2 message (counts, with-email count, kept rows, unresolved names) with `[Write to gtm tab] jobs_write:<id>` / `[Discard] jobs_discard:<id>`.

**Verify:** `npx -y deno check supabase/functions/jobsearch-puller/index.ts`. Commit `feat(jobsearch): jobsearch-puller phase worker (gate → resolve → order → poll → rank)`.

---

## Task 6: `jobsearch-sheet-writer`

**Files:**
- Create: `supabase/functions/jobsearch-sheet-writer/index.ts`

Steps: `POST {batch_id}`; batch must be `ranked` (else 409). Read `gtm!A1:ZZ`; headers; existing emails set (lowercase). GET `job_contacts?batch_id=eq.<id>&kept=is.true&order=company_name,rank&limit=2000` and the batch's companies. For each contact not already in `gtm`, build the row in header order with the fills from the design: `linkedinUrl, firstName, lastName, email, company, status=Send Email Direct, email sent=Needs Sending, linkedin sent=Needs Sending, jobLink, campaign (A_startup_founders for founder/job_poster else B_recruiters_sales), contactOrder=rank, isJobPoster=TRUE/FALSE, openRole=job_title, otherRoles, nPostings, roleFitTier=1, salary=salary_text, postedAt, fundingStage, employees, industry=industries, corporatePhone, listSource=leadsfriday, domain, lowData=TRUE when email blank, priority=High if employees ≤ 50 else Medium, seniorityLevel=seniority, ycBatch, roleType=GTM`. Unknown headers get `''`. `appendRows(sheet, 'gtm!A1', rows)`. Upload `toCsv(headers, rows)` to `leadsfriday-results/<batch_id>-gtm.csv`. PATCH `status='written'`. Telegram `✍️ <n> rows written to gtm (<skipped> already present) — <link #gid=1642822363>`. On error: `status='failed', error`, Telegram.

Verify: `deno check`. Commit `feat(jobsearch): jobsearch-sheet-writer appends kept contacts to the gtm tab`.

---

## Task 7: `telegram-inbox` — `jobs_*` callbacks

**Files:**
- Modify: `supabase/functions/telegram-inbox/index.ts` (add `invokeBatchFunction` beside `invokeFunction`; add `handleJobsCallback`; add dispatch in `handleCallback` before the ingest fallback)

Handler per action (order: `answerCallbackQuery` → claim → `editMessageText` → invoke):

| action | claim filter | patch | edit text | invoke |
|---|---|---|---|---|
| `jobs_pull` | `review_status=eq.awaiting&status=eq.awaiting_review` | `{review_status:'claimed', status:'approved'}` | `✅ Reviewed — pulling contacts` | `jobsearch-puller` |
| `jobs_skip` | same | `{review_status:'claimed', status:'skipped'}` | `⏭ Skipped this week` | — |
| `jobs_write` | `write_status=eq.awaiting&status=eq.ranked` | `{write_status:'claimed'}` | `✍️ Writing to gtm…` | `jobsearch-sheet-writer` |
| `jobs_discard` | same | `{write_status:'claimed', status:'discarded'}` | `🗑 Discarded` | — |
| `jobs_resume` | `watchdog_status=eq.awaiting` | `{watchdog_status:'claimed'}` then `{watchdog_status:'idle'}` | `▶️ Resumed — batch <date> at <status>` | `jobsearch-puller` (no phase; it derives from status) |

Zero rows claimed → return silently (Telegram already got its answer). Verify with `deno check`. Commit `feat(telegram-inbox): jobs_* callbacks for the job search gates`.

---

## Task 8: `pipeline-watchdog` — `job_batches` scan

**Files:**
- Modify: `supabase/functions/pipeline-watchdog/index.ts`

Add `checkJobBatchStalls()` after `checkForStalls()` inside the same request: GET `job_batches?status=in.(approved,resolving,ordered,delivered)&watchdog_status=eq.idle&updated_at=lt.<now-15m>&or=(watchdog_notified_at.is.null,watchdog_notified_at.lt.<now-1h>)&select=id,batch_date,status,updated_at&limit=50`. For each: claim `watchdog_status=eq.idle → awaiting` with `watchdog_notified_at=now`, then `sendMessage` `⚠️ Job batch <date> stalled at <status>\nNo heartbeat in <n> minutes.\n\nResume?` with `[▶️ Resume] jobs_resume:<id>`. Return `{…, job_batches: {scanned, notified}}`. The existing `validation_jobs` scan is untouched. Note the heartbeat claim: a `PATCH` to claim bumps `updated_at` via the trigger, which is fine — the next scan is gated by `watchdog_status` and `watchdog_notified_at`, not `updated_at`.

Verify with `deno check`. Commit `feat(pipeline-watchdog): notify-only scan of job_batches with jobs_resume`.

---

## Task 9: Dashboard routes

**Files:**
- Create: `app/api/jobsearch/batches/route.ts` (GET)
- Create: `app/api/jobsearch/batches/[id]/action/route.ts` (POST)

GET: cookie server client (`@/lib/supabase/server`). `?id=` absent → last 30 batches ordered `batch_date desc`. Present → `{batch, companies (ordered resolve_status, company_name), contacts (kept only, ordered company_name, rank)}`.

POST `{action}`: service-role REST helpers as in `app/api/instantly/push/route.ts`. Same claim table as Task 7, keyed by action `pull|skip|write|discard|resume`. Zero rows → `409 {error:'already handled'}`. Then invoke the same edge function with `{batch_id}`. Next 16: `params` is a `Promise`, `const { id } = await params`.

Verify `npx tsc --noEmit -p .` is clean for these files. Commit `feat(jobsearch): dashboard routes for batches and gate actions`.

---

## Task 10: Dashboard panel

**Files:**
- Create: `components/JobSearchPanel.tsx`
- Modify: `components/AdminDashboard.tsx` (`Section` union, sidebar item under Management with `Briefcase` icon, render block)

Panel: fetch `/api/jobsearch/batches` on mount; while any batch is in `approved|resolving|ordered|delivered` refresh every 15 s (same `setInterval` shape as `EmailValidator.loadRuns`). Table columns: date, status pill (colour by status group), added / pulled / unresolved, kept, Leadsfriday order id, links to `Jobs Final` and `gtm`. Row actions by status: `awaiting_review` → Pull / Skip; `ranked` → Write / Discard; `approved|resolving|ordered|delivered` with `watchdog_status='awaiting'` → Resume. Clicking a row expands it and fetches `?id=`: companies with resolve status / exclude reason, then kept contacts grouped by company (name, title, role, email, rank). Use the existing CSS variables (`--surface`, `--surface-raised`, `--border`, `--text-primary/secondary/tertiary`).

Verify `npm run build` compiles (or `npx tsc --noEmit`). Commit `feat(jobsearch): Job Search dashboard panel`.

---

## Task 11: Deploy workflow, README, docs

**Files:**
- Modify: `.github/workflows/deploy-functions.yml` (second step: add `jobsearch-notify jobsearch-puller jobsearch-sheet-writer`)
- Modify: `README.md` (env section: Supabase edge-function secrets table incl. the four new ones; one-time Google service-account setup)
- Create: `.env.example` (does not exist today; lists the Next.js vars and, as comments, the edge-function secrets)

Commit `chore(jobsearch): deploy the new functions; document secrets and service-account setup`.

---

## Task 12: Verification

1. `npx -y deno test supabase/functions/_shared/jobsearch/` → all pass.
2. `npx -y deno check supabase/functions/{jobsearch-notify,jobsearch-puller,jobsearch-sheet-writer,telegram-inbox,pipeline-watchdog}/index.ts` → clean.
3. `npx tsc --noEmit` (Next.js side) → clean.
4. Migration verified in Task 1.
5. **Manual end-to-end (needs the four secrets set and the functions deployed, i.e. after merge to `main`):** append three `Jobs Final` rows with `added_on = today` for Trunk Tools / trunktools.com, Peec AI / peec.ai, DepthFirst / depthfirst.com (titles `GTM Engineer`); `insert into job_batches (batch_date, companies_added) values (current_date, 3) returning id`; `POST jobsearch-notify {batch_id}`; tap through both gates; confirm ≤ 15 rows land in `gtm`; delete the three `Jobs Final` rows and the `gtm` rows afterwards. Tap each button twice: the second tap must be a no-op.
6. Confirm the watchdog's `job_batches` branch by setting a test batch to `ordered` with `updated_at = now() - interval '20 minutes'` and invoking `pipeline-watchdog`; expect one Telegram prompt and `watchdog_status='awaiting'`.

## One-time setup (owner)

1. Google Cloud → IAM → Service Accounts → create `jobsearch-sheets`, no roles needed. Keys → Add key → JSON. Download.
2. Share the spreadsheet with the service account's `client_email` as **Editor**.
3. `supabase secrets set GOOGLE_SERVICE_ACCOUNT_JSON="$(cat key.json)" JOBSEARCH_SHEET_ID=1wjvpjyX2g7UUkjgeOXRtPEb7-s4MQfmPOgikalpthcs APOLLO_API_KEY=… LEADSFRIDAY_API_TOKEN=… --project-ref rcfrumrbauwvyzfebxck`
4. Merge to `main`; the deploy workflow ships the three functions plus the modified `telegram-inbox` and `pipeline-watchdog`.
