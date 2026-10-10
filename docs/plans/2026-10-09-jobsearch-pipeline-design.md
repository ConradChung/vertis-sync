# Job Search Pipeline (GTM-engineer postings → ranked contacts → `gtm` tab)

**Date:** 2026-10-09
**Status:** Approved

## Overview

A weekly loop that turns the Monday job-scrape output in the Google Sheet `Conrad Masters, Jobs, Internships` (tab `Jobs Final`) into ranked decision-maker contacts in the `gtm` tab, with two manual gates answered in Telegram and mirrored in the dashboard. It reuses the NorthStar infrastructure exactly the way the email-validation pipeline does: Supabase tables as state, Deno edge functions as workers, `telegram-inbox` as the button handler, `pipeline-watchdog` for notify-only stall detection, and the admin dashboard for a second set of the same buttons.

Nothing from this pipeline ever reaches Instantly. The owner adds leads to a campaign by hand from the `gtm` tab.

Out of scope here: the Monday scrape itself (a Claude scheduled task; this repo only receives its one POST), and any change to the existing validation pipeline, the `instantly-*` functions, or the watchdog's handling of `validation_jobs`.

---

## Architecture

```
Claude scheduled task (Monday, outside this repo)
  - scrapes GTM-engineer postings, appends net-new companies to `Jobs Final`
    with added_on = run date, status blank
  - insert into job_batches (batch_date, companies_added) returning id
  - POST /functions/v1/jobsearch-notify {batch_id}   (service-role key)
      │
      ▼
jobsearch-notify                       ← Gate 1 prompt
  "🧭 Job scrape — Mon 12 Oct · 23 new companies …"
  [Reviewed, pull contacts] jobs_pull:<id>   [Skip this week] jobs_skip:<id>
  stores telegram_message_id; a second call edits that message (idempotent)
      │ owner reviews the sheet, marks rejects "Not a Right Fit", taps
      ▼
telegram-inbox (callback_query branch, new `jobs_*` actions)
  answerCallbackQuery → atomic claim (review_status awaiting→claimed) →
  editMessageText (strip keyboard) → invoke
  jobs_pull  → status 'approved',  invoke jobsearch-puller {batch_id}
  jobs_skip  → status 'skipped'
      │
      ▼
jobsearch-puller                       ← phase worker, ≤110 s per invocation,
  phase gate     approved  → resolving   PATCH updated_at as heartbeat
    read `Jobs Final` headers at run time, select batch rows
    (added_on = batch_date, status ≠ Not a Right Fit, title matches regex),
    exclude companies already in `gtm` (normalized name or domain),
    insert job_batch_companies (excluded rows kept with exclude_reason)
  phase resolve  resolving              Apollo POST /v1/accounts {name,domain}
    ≤20 per invocation, self-invoke; 401/403 = hard fail + Telegram
    when none pending: build Apollo people-search URL → apollo_url
  phase order    resolving → ordered    Leadsfriday POST /api/export-apollo/
    claim status first so a replay can't order twice; 403 = failed (credits)
  phase poll     ordered                GET status every ≤60 s, self-invoke
    delivered → fetch download_url now, upload to Storage
    leadsfriday-results/<batch_id>.csv → status 'delivered'
    cancelled → failed · >6 h polling → failed + Telegram
  phase rank     delivered → ranked     parse CSV, map columns, join to
    companies by domain then normalized name, assign role, rank, kept≤5
    Gate 2 prompt: "📇 Contacts ready — batch 12 Oct …"
    [Write to gtm tab] jobs_write:<id>   [Discard] jobs_discard:<id>
    write_status 'awaiting'
      │ owner taps
      ▼
telegram-inbox
  jobs_write   → claim write_status → invoke jobsearch-sheet-writer
  jobs_discard → status 'discarded'
      │
      ▼
jobsearch-sheet-writer                 ← ranked → written
  read `gtm` headers at run time, skip emails already present,
  values:append RAW in header order, append written rows to Storage CSV,
  Telegram "✍️ 103 rows written to gtm — <link>"

pipeline-watchdog (every 5 min, existing cron)
  + scan job_batches in (approved, resolving, ordered, delivered) with
    updated_at older than 15 min, watchdog_status idle, not notified in 1 h
    claim idle→awaiting, "⚠️ Job batch <date> stalled at <status>"
    [Resume] jobs_resume:<id> — never revives on its own

telegram-inbox  jobs_resume → claim watchdog_status awaiting→claimed,
  reset to idle, invoke jobsearch-puller {batch_id} (puller picks the phase
  from status)

Dashboard  Job Search panel: job_batches table, expandable companies +
  kept contacts, row buttons that hit /api/jobsearch/batches/[id]/action
  with the same conditional PATCHes and then invoke the same functions.
```

### Phase selection in the puller

The puller accepts `{batch_id, phase?}`. When `phase` is absent it derives it from `job_batches.status`: `approved → gate`, `resolving → resolve` (which falls through to `order` when nothing is pending), `ordered → poll`, `delivered → rank`. That is what makes `jobs_resume` and the dashboard's Resume a single invocation with no mode flags, and it is also why every self-invocation carries an explicit phase: the explicit value wins, the derived value is the fallback.

### Why the status claims are PATCH-with-filter

Every button and every phase transition is a `PATCH job_batches?id=eq.<id>&<field>=eq.<expected>` with `Prefer: return=representation`. Zero rows back means someone else already won (double-tap, Telegram retry, dashboard and Telegram racing) and the handler returns silently. This is the same pattern `finder_status` and `watchdog_status` use on `validation_jobs`; the spec's `review_status` / `write_status` / `watchdog_status` columns exist only to carry it.

The `order` phase claims `status resolving → ordered` *before* calling Leadsfriday. A replayed invocation then finds zero rows and does not place a second paid order. If the Leadsfriday call fails after the claim the batch goes to `failed` with the error, which is the visible, recoverable outcome.

---

## Database Changes

Migration `supabase/migrations/20261009233717_jobsearch_pipeline.sql` (the spec names it `20261009_jobsearch_pipeline.sql`; the repo's migrations all carry 14-digit versions and the CLI orders by that string, so this one does too).

Three tables, as in the spec:

- `job_batches` — one row per Monday scrape. `batch_date` is unique and equals `Jobs Final.added_on`. `status` is the pipeline position; `review_status`, `write_status`, `watchdog_status` are the three claim slots. Counters, Apollo URL, Leadsfriday order id/status/download URL, Storage path, error, and the Gate 1 Telegram message id live here. `updated_at` is maintained by the existing `update_updated_at_column()` trigger function from `20260322000001` and doubles as the watchdog heartbeat.
- `job_batch_companies` — one row per `Jobs Final` row the gate looked at for this batch, including excluded ones (`resolve_status = excluded`, `exclude_reason` ∈ `not_a_right_fit | already_in_gtm | title_mismatch`). Carries the sheet fields the writer needs later (`job_title`, `job_link`, `job_poster_*`, `salary_text`, `posted_at`, `employees`, `industries`, `location`, plus `other_titles`, `n_postings`, `funding_stage`, `yc_batch` so the `gtm` row can be filled without re-reading the sheet) and `apollo_org_id` once resolved. Unique on `(batch_id, domain)`.
- `job_contacts` — one row per Leadsfriday row, `raw` keeps the whole CSV row. `role`, `rank`, `kept` are the ranking output. Unique on `(batch_id, email)`; blank emails are stored as NULL so they do not collide.

Indexes: `job_contacts (batch_id, company_name, rank)` and a partial index on `job_batches (status)` for the active statuses the watchdog and dashboard poll.

Storage bucket `leadsfriday-results` (private) is created in the same migration with an `insert into storage.buckets … on conflict do nothing`. `validation-results` was created in the dashboard, so this is the first bucket the repo tracks; the insert is idempotent and matches what the dashboard would have done.

---

## Edge Functions

All three new functions are Deno, raw PostgREST, no npm client. `supabaseRequest`, `tg`, and the service-to-service invoke helper are copied from `telegram-inbox/index.ts`, matching how every other function in this repo is self-contained.

The two pieces that would otherwise be copied three times live in `supabase/functions/_shared/jobsearch/`:

- `pure.ts` — the title regex, name/domain normalization, role assignment, rank/keep, the Apollo URL builder, the CSV parser (the slice-based one from `telegram-inbox`), and the Leadsfriday-column → `job_contacts` mapping. No I/O, so it is unit-tested with `deno test`.
- `sheets.ts` — Google Sheets REST client: service-account JWT signed with WebCrypto RS256, `readRange`, `appendRows`. Reads headers at run time; never hardcodes a column index.

Supabase bundles `_shared` imports at deploy time, so this adds nothing to the deploy workflow beyond the three function names.

### `jobsearch-notify`
`POST {batch_id}`. Loads the batch, sends the Gate 1 message to `TELEGRAM_CHAT_ID` with a deep link to `Jobs Final` (`#gid=935519386`), stores `telegram_message_id`. If the batch already has a message id, edits that message instead (idempotent; the scheduled task may retry).

### `telegram-inbox` (extended)
New dispatch branch in `handleCallback`, before the ingest fallback, for `jobs_pull | jobs_skip | jobs_write | jobs_discard | jobs_resume`, each gated on `targetId`. Order inside each handler mirrors the existing ones: `answerCallbackQuery`, atomic claim, `editMessageText` to strip the keyboard, invoke. A sibling of `invokeFunction` posts `{batch_id}` instead of `{job_id}`.

### `jobsearch-puller`
Phase worker as described above. Each invocation loads the batch, runs one phase under a 110 s budget, PATCHes `updated_at` as it goes, and self-invokes with the next phase. Secrets: `GOOGLE_SERVICE_ACCOUNT_JSON`, `JOBSEARCH_SHEET_ID`, `APOLLO_API_KEY`, `LEADSFRIDAY_API_TOKEN`.

Apollo resolution uses `POST https://api.apollo.io/api/v1/accounts {name, domain}` and reads `organization_id` from the created account. A 401/403 is a hard failure of the whole batch (Telegram names the secret). The people-search URL is the template verified by hand on 2026-10-09; at most 60 `organizationIds[]` per URL, extra companies are marked `unresolved` with reason `batch_cap` and reported in the Gate 2 message (splitting into a second Leadsfriday order is deferred until a batch actually exceeds 60).

Leadsfriday: `POST /api/export-apollo/` multipart with `contact_count = max(50, resolved × 15)`, `verify_emails=yes`. `GET /api/export-apollo/{order_id}/` until `delivered`; the `download_url` expires, so the CSV is fetched and uploaded to Storage in the same invocation.

Ranking: `role` by title in priority `job_poster` (name match to the company's `job_poster_name`) → `recruiter` → `sales_leader` → `founder` → `other`; `rank` within company = role priority, then has-email first, then seniority; `kept = rank ≤ 5`.

### `jobsearch-sheet-writer`
`POST {batch_id}`. Reads `gtm` headers and the existing `email` column, drops kept contacts already present, appends the rest in header order with the fixed fills from the spec (`status=Send Email Direct`, `campaign` by role, `listSource=leadsfriday`, `priority` by employees, `roleType=GTM`, …). Writes the same rows to `leadsfriday-results/<batch_id>-gtm.csv`, sets `written`, sends the completion Telegram with the `gtm` link (`#gid=1642822363`).

### `pipeline-watchdog` (extended)
A second scan over `job_batches` next to the `validation_jobs` scan, with a 15-minute stall threshold (poll heartbeats keep `updated_at` fresh), the same claim-before-send, the same one-notification-per-hour cap, and a `jobs_resume:<id>` button. It never invokes anything itself.

---

## Dashboard

`components/JobSearchPanel.tsx`, mounted from a new `'job-search'` `Section` in `AdminDashboard.tsx` with a sidebar item under Management. Table of batches newest first (date, status pill, companies added/pulled/unresolved, contacts kept, Leadsfriday order id, sheet links), row actions matching the Telegram buttons, expandable row with the company list and kept contacts grouped by company. Polls every 15 s while any batch is in a working status.

Routes:
- `GET /api/jobsearch/batches` — batches (and, with `?id=`, that batch's companies and kept contacts). Cookie-based server client, like `/api/validate/status`.
- `POST /api/jobsearch/batches/[id]/action {action}` — `pull | skip | write | discard | resume`. Service-role REST like `/api/instantly/push`; the same `..._status=eq.awaiting` conditional PATCHes as `telegram-inbox`, then the same edge-function invoke. A zero-row claim returns `409`.

---

## Interface contract with the Monday scheduled task

Stable; the task depends on exactly this and nothing else in the repo:

```sql
insert into job_batches (batch_date, companies_added)
values ('2026-10-12', 23)
returning id;
```

```http
POST https://rcfrumrbauwvyzfebxck.supabase.co/functions/v1/jobsearch-notify
Authorization: Bearer <service-role key>
apikey: <service-role key>
Content-Type: application/json

{"batch_id": "<id>"}
```

`batch_date` must equal the `added_on` value the task wrote to `Jobs Final` (ISO `YYYY-MM-DD`). Re-posting the same `batch_id` edits the existing Telegram prompt rather than sending a second one.

---

## Security

- The three new functions deploy JWT-verified and are only ever invoked service-to-service (scheduled task, `telegram-inbox`, dashboard routes, self-invokes), all with the service-role key.
- `telegram-inbox` keeps its webhook-secret check; the new buttons only exist in the owner's chat, which is the access control, exactly as for the validation prompts.
- The Google service account has editor access to this one spreadsheet and nothing else. Its JSON key lives only in the `GOOGLE_SERVICE_ACCOUNT_JSON` edge-function secret.
- Apollo's `accounts` endpoint creates a CRM account record per company. That is accepted: it is free-tier and harmless, and it is the only free way to obtain an `organization_id`.

## Environment Variables (new, all Supabase edge-function secrets)

| Variable | Purpose |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Full JSON key of a service account the sheet is shared with |
| `JOBSEARCH_SHEET_ID` | Spreadsheet id (default `1wjvpjyX2g7UUkjgeOXRtPEb7-s4MQfmPOgikalpthcs`) |
| `APOLLO_API_KEY` | Apollo `x-api-key` for `POST /v1/accounts` |
| `LEADSFRIDAY_API_TOKEN` | Leadsfriday bearer token |

Set with `supabase secrets set …`. No Vercel env vars are added: the dashboard routes reuse `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, which already exist.

## Error Handling / Edge Cases

- Double-tap or dashboard/Telegram race on any button: the conditional PATCH returns zero rows, handler exits, nothing is invoked twice.
- Scheduled task retries `jobsearch-notify`: edits the stored message instead of sending another.
- Apollo 401/403: batch `failed`, Telegram names `APOLLO_API_KEY`, no retry loop.
- Apollo returns no `organization_id`: company `unresolved`, batch continues, count surfaces in Gate 2.
- All companies unresolved or excluded: batch `failed` with `error = 'no companies to order'` and a Telegram note (no paid order for nothing).
- Leadsfriday 403: `failed`, `error = 'insufficient credits'`, Telegram.
- Leadsfriday `cancelled` or 6 hours of polling: `failed`, Telegram.
- Leadsfriday row with no matching company: still stored, `company_id` null, role/rank computed on its own company name; it is kept only if it ranks.
- `gtm` already has a kept contact's email: skipped on write, so re-running the writer is safe.
- Watchdog fires while a puller invocation is genuinely slow: Resume runs the puller again for the same status; `gate` and `order` are claim-protected, `resolve` and `rank` are idempotent per row, `poll` is harmless to duplicate.
