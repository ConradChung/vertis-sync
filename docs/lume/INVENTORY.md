# Lume — Inventory of what already exists

**Date:** 2026-10-14
**Branch:** `lume` (cut from `main` at `904dc3d`)
**Purpose:** Step 0 of the Lume build. Everything Lume reads from, taps into, or must never bypass, with file paths. Written before any Lume code.

Repo facts first:

- The repo root **is** a Next.js app (`northstarcrm`, Next 16.1.6, Tailwind 4, shadcn `new-york`). There is no `apps/` convention, so Lume goes in **`lume/`** at the root as a second Next app, per the spec's own layout.
- There is **no `CLAUDE.md`** in the repo (the prompt assumed one). The runbook lives in `README.md` and `docs/plans/*`. Task "Finish" adds `CLAUDE.md` with the Lume section.
- `docs/lume/SPEC.md` was copied from `~/Downloads/Vertis_Sync/SPEC.md`. The Manus reference files are in `docs/lume/reference/` (`DESIGN.md`, `globals.css`, `orb.tsx`, five `mock/*.json`).
- Supabase project `rcfrumrbauwvyzfebxck`. 14 edge functions deployed and ACTIVE, all from disk via `.github/workflows/deploy-functions.yml` (`telegram-inbox`, `slack-inbox`, `hnwi-pipeline-orchestrator` deploy with `--no-verify-jwt`; the rest verify JWT).

---

## 1. Pipelines

### 1a. CSV email-validation pipeline (the core)

The spine every other intake feeds. State is `validation_jobs` + `validation_rows`; workers are Deno edge functions that self-reinvoke under a 110 s budget and PATCH the job row as a heartbeat.

```
intake ──▶ telegram_ingests (awaiting_approval)
            │  owner taps Approve / Approve+Enrich / Deny   [telegram-inbox]
            ▼
         validation_jobs (pending) + validation_rows (pending)
            │  blank emails? ──▶ finder_status=awaiting_decision ──▶ Find them / Validate only   [telegram-inbox]
            ▼
         contact-email-finder  (blank rows → email or no_email)        connector-os
            ▼
         email-validator       (pending → valid|invalid|error)          MailTester Ninja, 10% Telegram milestones
            │  job.enrich && !enrich_started → latch, rows enrichment_status=pending
            ▼
         operating-city-enricher (Perplexity → Haiku, merges row_data.operating_city / icp_status) → chains back into email-validator
            ▼
         email-validator export: validation-results/jobs/<job_id>/valid.csv, status=completed
            │  valid_count>0 && instantly_status=idle → force_reply "Reply with campaign NAME"
            ▼
         telegram-inbox Instantly flow: name → camp_pick → barriers (bar_loc/bar_co, camp_tpl, camp_nolo) → push_next → company review (push_strict/push_std) → push_go
            ▼
         instantly-push (rows instantly_status pushed|filtered|error; job instantly_status pushing→done) → Telegram receipt with 🚀 Launch campaign (camp_launch)
```

| Piece | Path |
|---|---|
| Tables | `supabase/migrations/20260322000001_create_validation_tables.sql` (+ columns added by `20260424…`, `20260427…`, `20260721000001/4/5/6`, `20260810000001`, `20260811000001/2/3`, `20260822000001`) |
| `telegram_ingests` | `supabase/migrations/20260721000003_create_telegram_ingests.sql`, `…0007_add_slack_ingest_support.sql` |
| `campaign_templates` (2 rows: "Zenport Campaign", "Zenport Campaign — No Location") | `supabase/migrations/20260811000002_add_campaign_templates.sql`, `…0003_add_no_location_campaign_split.sql` |
| Intake: Telegram document | `supabase/functions/telegram-inbox/index.ts` `handleDocument` |
| Intake: Slack file share | `supabase/functions/slack-inbox/index.ts` (intake only; approval still happens in Telegram; `telegram-inbox` replies to Slack via `sender_platform='slack'`) |
| Intake: Leadsfriday delivery | `supabase/functions/leadsfriday-order/index.ts` poll phase creates the same `telegram_ingests` row (sender "Leadsfriday (Apollo link)") |
| Intake: dashboard CSV upload | `app/api/validate/start/route.ts` → creates job, invokes `email-validator` directly (no Telegram gate) |
| Intake: Apify last run (FMCSA filter) | `app/api/validate/apify/start/route.ts` (`source='apify'`, `filter_stats`), design `docs/plans/2026-04-24-apify-validate-pipeline-design.md` |
| Stage: finder | `supabase/functions/contact-email-finder/index.ts` |
| Stage: validator | `supabase/functions/email-validator/index.ts` |
| Stage: enricher | `supabase/functions/operating-city-enricher/index.ts` |
| Stage: Instantly push | `supabase/functions/instantly-push/index.ts` (`mode:'preview'` returns counts + first 10 normalized names; the dashboard and Telegram both call it) |
| Dashboard mirror | `components/EmailValidator.tsx`; routes `app/api/validate/{start,status,results}/route.ts`, `app/api/instantly/campaigns/route.ts`, `app/api/instantly/push/route.ts` (GET preview, PATCH barriers, POST push) |
| Status SQL | `supabase/queries/validation_status.sql` |

Status enums (live constraints):

| Column | Values |
|---|---|
| `validation_jobs.status` | `pending, processing, completed, failed` (check constraint). `cancelled` is also written by `20260811000005` and checked by every worker's `isHalted()`. **Verify the live constraint before Lume shows a Cancel button.** |
| `validation_jobs.source` | `csv, apify, hnwi, telegram` |
| `validation_jobs.finder_status` | `idle, awaiting_decision, decided` (claim slot) |
| `validation_jobs.watchdog_status` | `idle, awaiting, claimed` (claim slot) |
| `validation_jobs.instantly_status` | `idle, awaiting_campaign, choosing_campaign, configuring, reviewing_company, pushing, done, cancelled, error` |
| `validation_rows.status` | `pending, valid, invalid, error, no_email` |
| `validation_rows.enrichment_status` | `skipped, pending, done, unknown, error` |
| `validation_rows.instantly_status` | `skipped, pushed, filtered, error` |
| `telegram_ingests.status` | `awaiting_approval, approved, rejected, error` |
| `telegram_ingests.sender_platform` | `telegram, slack` |

Other job columns Lume will read: `total_rows, processed_rows, valid_count, invalid_count, enriched_rows, rows_missing_email, emails_found, emails_not_found, eta_seconds, eta_updated_at, storage_path, column_order, filter_stats, enrich, enrich_started, icp_filter, icp_description, find_emails, location_barrier, company_barrier, company_strict, instantly_campaign_id/_name, instantly_campaign_id_nolocation/_name_nolocation, instantly_pushed, instantly_filtered, instantly_errors, instantly_pushed_nolocation, instantly_prompt_message_id, instantly_campaign_candidates, watchdog_notified_at`.

### 1b. HNWI / RIA wealth pipeline

Apify actors → four validation jobs (`hnwi-signals`, `hnwi-email-found`, `ria-signals`, `ria-email-found` filename prefixes) → `hnwi-email-finder` → `email-validator`. Triggered from the dashboard route and the `hnwi-wealth-pipeline` Claude skill.

| Piece | Path |
|---|---|
| Orchestrator (phases `hnwi` → `ria`, self-invoking, Apify polling) | `supabase/functions/hnwi-pipeline-orchestrator/index.ts` (actor `belcaidsaad~wealth-management-scraper-saad-belcaid-market-saad-belcaid`) |
| Email finder (connector-os) | `supabase/functions/hnwi-email-finder/index.ts` |
| Trigger route | `app/api/validate/hnwi/start/route.ts` |
| Source tag | `validation_jobs.source='hnwi'` (`20260427000001_add_hnwi_source.sql`) |

### 1c. Instantly lead rotation

| Piece | Path |
|---|---|
| `lead_bank` (state `queued, active, completed, replied, bounced, unsubscribed, skipped`; 2,212 rows live), `rotation_runs` (11 rows) | `supabase/migrations/20261008222655_instantly_lead_rotation.sql` |
| Cron `instantly-rotate-am` 13:00 UTC, `instantly-rotate-pm` 01:00 UTC → `POST /functions/v1/instantly-rotate?mode=rotate` (anon JWT) | `supabase/migrations/20261008223419_instantly_rotation_schedule.sql` |
| `rotation_dashboard()` SECURITY DEFINER RPC (counts, last 30 runs, daily, cron state) | `supabase/migrations/20261008224840_rotation_dashboard_rpc.sql` |
| Worker (`mode=rotate|trim`; `ROTATE_CAMPAIGN_ID` default `869d73b3-5bf3-4f1c-ba8c-43ac6d0f529d`, `ROTATE_CAP` 1000, `ROTATE_MAX_PUSH` 450, `ROTATE_TIME_BUDGET_MS` 110000; uses `@supabase/supabase-js`, unlike every other function) | `supabase/functions/instantly-rotate/index.ts` |
| Campaign retarget after plan downgrade | `supabase/migrations/20261009074150_lead_bank_retarget_campaign.sql` |
| Static dashboard | `public/dashboard/instantly-rotation.html`; `hud_todos` table (realtime-enabled, the only table in `supabase_realtime`) `20261008230749_hud_todos.sql` |
| Runbook | `docs/instantly-rotation.md` |

This is the **only** place a cron pushes leads into Instantly today. It stays as is; Lume's Rotate screen reads `lead_bank` / `rotation_runs` and never calls Instantly.

### 1d. Job-search pipeline (recruiter campaign source)

| Piece | Path |
|---|---|
| `job_batches` (status `awaiting_review, skipped, approved, resolving, waiting_fill, ordered, delivered, ranked, written, discarded, failed, merged`; claim slots `review_status awaiting/claimed`, `write_status idle/awaiting/claimed`, `watchdog_status idle/awaiting/claimed`), `job_batch_companies` (`resolve_status pending/resolved/unresolved/excluded`, `fit_tier`), `job_contacts` (`role job_poster/recruiter/sales_leader/founder/other`, `rank`, `kept`) | `supabase/migrations/20261009233717_jobsearch_pipeline.sql`, `20261010015401_jobsearch_fill_to_minimum.sql` |
| Gate 1 prompt (idempotent edit; merges a new scrape into an open batch) | `supabase/functions/jobsearch-notify/index.ts` |
| Phase worker `gate / fill_more / refill / resolve / order / poll / rank` (`POST {batch_id, phase?}`, phase derived from status) | `supabase/functions/jobsearch-puller/index.ts` |
| Gate 2 "Write" | `supabase/functions/jobsearch-sheet-writer/index.ts` |
| Shared pure code + tests (`deno test`) | `supabase/functions/_shared/jobsearch/{pure,pool,sheets}.ts` + `*_test.ts` |
| Hourly refill cron `jobsearch-refill` `17 * * * *` → `jobsearch_refill_tick()` | `20261010015401_jobsearch_fill_to_minimum.sql` |
| Dashboard | `components/JobSearchPanel.tsx`; `app/api/jobsearch/batches/route.ts` (GET, `?id=` adds companies + kept contacts); `app/api/jobsearch/batches/[id]/action/route.ts` (POST `pull|skip|write|discard|resume|abort|order_now`, same conditional PATCHes as Telegram, 409 on zero rows) |
| Design (3 revisions) | `docs/plans/2026-10-09-jobsearch-pipeline-design.md`, plan `docs/plans/2026-10-09-jobsearch-pipeline.md` |
| External input contract | Claude scheduled task inserts `job_batches(batch_date, companies_added)` then `POST /functions/v1/jobsearch-notify {batch_id}`; sheet `1wjvpjyX2g7UUkjgeOXRtPEb7-s4MQfmPOgikalpthcs` tabs `Jobs Final` (gid 935519386) and `gtm` (gid 1642822363) |

Nothing from this pipeline reaches Instantly; the recruiter campaign is sent from Gmail by hand from the `gtm` tab.

### 1e. Apollo link → Leadsfriday order (second CSV intake)

| Piece | Path |
|---|---|
| `apollo_orders` (status `awaiting_count, ordering, ordered, delivered, ingested, cancelled, failed`; claim slot `count_status awaiting/claimed`; `credits_deducted`, `new_balance`, `ingest_id`) | `supabase/migrations/20261010030000_apollo_orders.sql` |
| Intake (Apollo people URL, `lf <id>`, bare count) | `supabase/functions/telegram-inbox/index.ts` `handleApolloOrPasteText`, `handleLfoCountReply`, `handleBareCount` |
| Worker phases `order` (ordering→ordered, 💳 receipt) / `poll` (ordered→delivered→ingested, 12 h cap) | `supabase/functions/leadsfriday-order/index.ts` |
| Storage | `raw-uploads/leadsfriday/<id>.csv` |

### 1f. Legacy NorthStar CRM (not a pipeline, but in the same DB and app)

`profiles` (role admin/client), `campaigns` (client ↔ Instantly campaign id), `onboarding_steps`, `stage1_onboarding`, `stage2_onboarding`, `onboarding_forms`, `client_onboarding_checklist`, `client_attachments`, `ai_runs` (copywriter / clay-prompts / market-research outputs), `email_validation_runs` + `email_validation_results` (pre-March legacy), `validation_run_snapshot_20260811`. Buckets `avatars`, `client-attachments`. Instantly analytics wrapper `lib/instantly.ts` (`getCampaignAnalytics`, `getDailyAnalytics`, `getStepAnalytics`) behind `app/api/analytics/route.ts`.

**Name collision:** the spec's `campaigns` table already exists with a different meaning (client assignment). Lume's unified campaign table is **`lume_campaigns`**.

---

## 2. Manual gates (the atomic-claim pattern)

All inbound taps land in `supabase/functions/telegram-inbox/index.ts` `handleCallback` (dispatch at the bottom of the file; webhook verified by `X-Telegram-Bot-Api-Secret-Token` = `TELEGRAM_WEBHOOK_SECRET`; `verify_jwt: false`). The pattern, in order: `answerCallbackQuery` → **conditional PATCH with `Prefer: return=representation`** (zero rows = someone else won, return silently) → `editMessageText` to strip the keyboard → invoke the worker. The dashboard copies the same PATCH filters, never a different one.

| `callback_data` | Emitted by | Claim (PATCH filter → patch) | Effect | Dashboard mirror today |
|---|---|---|---|---|
| `approve:<ingest>` / `approve_enrich:<ingest>` | `telegram-inbox` `handleDocument`, `slack-inbox`, `leadsfriday-order` | `telegram_ingests?id&status=eq.awaiting_approval` → `approved` | downloads CSV from `raw-uploads`, creates `validation_jobs` (`source='telegram'`, `enrich`) + chunked `validation_rows`; if blank emails → `finder_status='awaiting_decision'` + finder prompt, else invokes `email-validator`; quotes ETA | **none** |
| `deny:<ingest>` | same | same filter → `rejected` | deletes the raw upload, tells the sender | **none** |
| `finder_go:<job>` / `finder_skip:<job>` | `telegram-inbox` after approve | `validation_jobs?id&finder_status=eq.awaiting_decision` → `decided` | invokes `contact-email-finder`, or retires blank rows to `no_email` and invokes `email-validator` | **none** |
| `wd_resume:<job>` | `pipeline-watchdog` | `validation_jobs?id&watchdog_status=eq.awaiting` → `claimed`, then back to `idle` | invokes the stage the job stopped in (finder / validator / enricher) | **none** |
| campaign NAME (force_reply text) | `email-validator` `promptForCampaign` | match `instantly_prompt_message_id`, require `instantly_status=awaiting_campaign` | resolves by Instantly search; exact match → barrier screen; several → `camp_pick` buttons | `EmailValidator.tsx` uses a `<select>` from `/api/instantly/campaigns` instead |
| `camp_pick:<job>:<i>`, `bar_loc`, `bar_co`, `camp_tpl:<job>:<i>`, `camp_nolo`, `push_next`, `push_strict`, `push_std`, `push_cancel` | `telegram-inbox` barrier / review screens | plain PATCHes on `instantly_status` and barrier columns (not claim-guarded; the screens are re-rendered from the row) | configure → `push_next` → company review (`instantly-push mode:'preview'`) or `startPush` | `/api/instantly/push` PATCH (barriers) + GET (preview) |
| `push_go:<job>` | company review screen | `instantly_status='pushing'` (unconditional) then `instantly-push` | pushes valid rows; `instantly-push` → `done` + receipt | `/api/instantly/push` POST (guards `status=completed`, refuses if already `pushing`) |
| `camp_launch:<job>` | `instantly-push` receipt | none (refuses if the campaign has no sequence) | `POST /campaigns/{id}/activate` on Instantly | **none** |
| `jobs_pull` / `jobs_skip` | `jobsearch-notify` | `review_status=eq.awaiting&status=eq.awaiting_review` → `claimed` + `approved`/`skipped` | invokes `jobsearch-puller` | `/api/jobsearch/batches/[id]/action` `pull`/`skip` |
| `jobs_write` / `jobs_discard` | `jobsearch-puller` rank phase | `write_status=eq.awaiting&status=eq.ranked` → `claimed` (+ `discarded`) | invokes `jobsearch-sheet-writer` | `write`/`discard` |
| `jobs_resume` | `pipeline-watchdog` | `watchdog_status=eq.awaiting` → `claimed` → `idle` | invokes `jobsearch-puller` (phase from status) | `resume` |
| `jobs_abort` | puller, watchdog, `telegram-inbox` after pull | `status=in.(approved,resolving,waiting_fill,ordered,delivered)` → `discarded`, `error='aborted by owner'` | puller re-checks status and stops | `abort` |
| `jobs_order_now` | puller (waiting_fill message) | `status=eq.waiting_fill` → `resolving`, `force_order=true` | invokes `jobsearch-puller` | `order_now` |
| `lfo_count:<order>:<n>` / bare number / reply | `telegram-inbox` Apollo intake | `apollo_orders?id&count_status=eq.awaiting&status=eq.awaiting_count` → `claimed`, `ordering`, `contact_count` | invokes `leadsfriday-order` (spends credits) | **none** |
| `lfo_custom` | same | none (re-renders prompt) | — | — |
| `lfo_cancel` | same | same filter → `cancelled` | — | **none** |
| `lfo_abort` | `telegram-inbox`, `leadsfriday-order` receipt | `status=in.(awaiting_count,ordering,ordered)` → `cancelled`, `error='stopped by owner'` | stops polling | **none** |

Telegram message ids are stored for: `telegram_ingests.telegram_message_id` (the Approve prompt), `validation_jobs.instantly_prompt_message_id` (campaign-name prompt), `job_batches.telegram_message_id` (Gate 1), `apollo_orders.telegram_message_id` (count prompt). **Not stored:** the finder prompt, the watchdog prompts, the Gate 2 prompt, the barrier / review screens. A decision made outside Telegram can edit the first group and must post a fresh message for the second.

Design rationale for the pattern: `docs/plans/2026-10-09-jobsearch-pipeline-design.md` "Why the status claims are PATCH-with-filter" and `docs/plans/2026-07-21-telegram-csv-approval-design.md`.

---

## 3. The watchdog

| Piece | Path |
|---|---|
| Cron `pipeline-watchdog` `*/5 * * * *` → `public.pipeline_watchdog()` → `net.http_post` to `/functions/v1/pipeline-watchdog` (secrets from `vault.decrypted_secrets` `service_role_key`, `project_url`) | `supabase/migrations/20260822000002_watchdog_notify_only.sql` (supersedes `20260811000004/5`) |
| Edge function, **notify only, never revives** | `supabase/functions/pipeline-watchdog/index.ts` |
| Claim columns | `validation_jobs.watchdog_status/watchdog_notified_at` (`20260822000001`), `job_batches.watchdog_status/watchdog_notified_at` |
| Dead table | `pipeline_watchdog_state` (comment: unused since 2026-08-22) |

Coverage:

- `validation_jobs` in `pending, processing`, created < 24 h ago, `finder_status <> awaiting_decision`, `watchdog_status = idle`, not notified in the last hour. Stall = no heartbeat (`updated_at`, latest `processed_at`, `created_at`) for 10 min. Claims `idle → awaiting`, sends ⚠️ with `wd_resume`.
- `job_batches` in `approved, resolving, ordered, delivered`, `updated_at` older than 15 min, same claim and 1 h cap, sends `jobs_resume` + `jobs_abort`.
- **Not covered:** `apollo_orders` (the `leadsfriday-order` poll has its own 12 h cap), `instantly-rotate` (errors only in `rotation_runs.errors`), `hnwi-pipeline-orchestrator`, `waiting_fill` batches (by design; the hourly refill owns them).

The notify-only rule (migration comment): the old self-reviving watchdog twice burned MailTester credits on abandoned lists and could not tell "stalled" from "slow". Anything Lume adds on a cron (rotation rules) follows the same rule: detect, claim, ping, wait for a tap.

---

## 4. External integrations and secrets

| System | Where it is called | Secret(s) | Where set |
|---|---|---|---|
| Telegram Bot API | every edge function (`tg()` / `sendTelegram()`), webhook in `telegram-inbox` | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET` | edge secrets |
| Slack | `slack-inbox` (Events API, signature check), `telegram-inbox` `slackPostMessage` (reply to sender) | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` | edge secrets (**missing from `.env.example`**) |
| MailTester Ninja | `email-validator` | `MAILTESTER_API_KEY` | edge secret |
| connector-os email finder | `contact-email-finder`, `hnwi-email-finder` | `CONNECTOR_OS_API_KEY` | edge secret (**missing from `.env.example`**) |
| Perplexity + Anthropic (Haiku) | `operating-city-enricher` | `PERPLEXITY_API_KEY`, `ANTHROPIC_API_KEY` | edge secrets (**missing from `.env.example`** on the edge side; Vercel has `ANTHROPIC_API_KEY` for the AI tools) |
| Apify | `hnwi-pipeline-orchestrator`; `app/api/validate/apify/start` | `APIFY_API_TOKEN` (edge + Vercel), `APIFY_ACTOR_ID` (Vercel, default `MB6MTbLZh4tkXpJxg`) | both |
| Instantly v2 REST | `instantly-push`, `instantly-rotate`, `telegram-inbox` (search, campaign read, PATCH sequences, create sibling, activate); `lib/instantly.ts`, `app/api/instantly/*` | `INSTANTLY_API_KEY` (edge + Vercel); optional `ROTATE_CAMPAIGN_ID`, `ROTATE_CAP`, `ROTATE_MAX_PUSH`, `ROTATE_TIME_BUDGET_MS` | both |
| Google Sheets REST (service-account JWT, WebCrypto RS256) | `_shared/jobsearch/sheets.ts` used by `jobsearch-notify/puller/sheet-writer` | `GOOGLE_SERVICE_ACCOUNT_JSON`, `JOBSEARCH_SHEET_ID` | edge secrets |
| Apollo (`POST /api/v1/accounts` only) | `jobsearch-puller` | `APOLLO_API_KEY` | edge secret |
| Leadsfriday | `jobsearch-puller`, `leadsfriday-order` | `LEADSFRIDAY_API_TOKEN`, optional `LEADSFRIDAY_BASE_URL` | edge secrets |
| Supabase (PostgREST, Storage, Functions) | everything | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (edge, auto); `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (Vercel); vault `project_url`, `service_role_key` for pg_cron | both + vault |

**Not wired anywhere in the repo** (named in SPEC.md): Gmail API (recruiter sender, Pub/Sub push), Muse, Linear, Instantly **webhooks** (replies/bounces arrive nowhere today; `app/api/replies/route.ts` returns `[]`), Slack outbound to a Kaspen channel, Google Sheet mirror of campaign status.

Live infra snapshot (2026-10-14): tables listed in §1; `supabase_realtime` publication contains only `hud_todos`; buckets `avatars, client-attachments, leadsfriday-results, raw-uploads, validation-results`; pg_cron jobs `pipeline-watchdog`, `instantly-rotate-am`, `instantly-rotate-pm`, `jobsearch-refill`.

**Security advisory surfaced by Supabase:** RLS is disabled on `profiles, email_validation_results, validation_jobs, validation_rows, telegram_ingests, pipeline_watchdog_state, validation_run_snapshot_20260811, job_batches, job_batch_companies, job_contacts, apollo_orders`. These are reachable with the anon key. Not a Lume task, but Lume must not widen it: Lume reads only through server-side routes with the service role, and its new tables ship with RLS on and no anon policies.

---

## 5. What `AdminDashboard.tsx` shows today

`components/AdminDashboard.tsx` (785 lines), mounted by `app/admin/page.tsx` (requires `profiles.role='admin'`). Sidebar (`components/ui/sidebar.tsx`) with two groups:

- Management: **Clients** (profiles CRUD, DocuSign url, onboarding stage, logo), **Campaigns** (client ↔ Instantly campaign id rows; `CampaignAnalytics.tsx` renders `/api/analytics` summary/daily/steps), **Client Next Steps** (`ClientNextSteps.tsx`), **Onboarding Data** (stage 1–3 form answers), **Email Validator** (`EmailValidator.tsx`: CSV upload → `/api/validate/start`, ambiguous-column picker, progress polling `/api/validate/status`, previous runs with source badge, Download / Copy valid CSV via `/api/validate/results`, Instantly push panel: campaign `<select>`, barrier toggles, preview names, Push), **Job Search** (`JobSearchPanel.tsx`: batches table with status pills, action buttons mirroring Telegram, expandable companies + kept contacts, 15 s polling).
- AI tools: **Copywriter**, **Clay Prompts**, **Market Research** (Anthropic SDK routes, outputs saved to `ai_runs`), **Settings** (`AccountSettings.tsx`).

Separately: `public/dashboard/instantly-rotation.html` (rotation counts via `rotation_dashboard()`), and `app/dashboard/page.tsx` → `ClientDashboard.tsx` for client logins.

Lume replaces none of this. It is a separate app over the same tables; the admin dashboard keeps working.

---

## 6. `jobsearch-pipeline` branch

`git log main..jobsearch-pipeline` is **empty**; `main` is 8 commits ahead (PR #1 merged at `df85409`, then revisions 2 and 3 landed directly on `main`). Same for `feat/instantly-push`. **Nothing to merge first.** Both branches can be deleted after Lume ships.

---

## 7. Gaps the Lume plan has to account for

1. **No stage-events table.** `rotation_runs` is per rotation run only; `ai_runs` is the AI tools' output log. The `events` feed is new (design doc §Data).
2. **No pending-action / approval table** for Lume-originated or agent-originated high-risk actions. New.
3. **Spec `validation_items` (per-lead auto_pass / needs_review verdicts) does not exist.** The pipeline validates *emails* and (optionally) enriches `icp_status` into `row_data`; the human gates are per *batch* (ingest, finder decision, campaign choice, company review, job-search gates). Lume's Validate screen is the queue of those gates, with per-row detail from `validation_rows`.
4. **Spec `orders` does not exist as one table.** A "pull" is one of: `apollo_orders` row, `telegram_ingests` row (Telegram / Slack / Leadsfriday CSV), `validation_jobs` with `source in (apify, hnwi, csv)`, or a `job_batches` Leadsfriday order. Lume unifies them in a view.
5. **Spec `campaigns` collides** with the CRM `campaigns` table → `lume_campaigns`.
6. **Spec `scheduled_jobs`** = `cron.job` (4 jobs) plus the Claude scheduled tasks that live outside the repo (Monday/every-other-day job scrape, PM reactions, HNWI). A view over `cron.job` + a small registry table for the external ones.
7. Six Telegram gates have **no dashboard mirror** (approve/deny, finder, wd_resume, Instantly name/launch, lfo_*). Lume adds them.
8. `.env.example` omits five edge secrets that functions read (§4). Lume's README fixes the list; `.env.example` gets the missing names (comment lines only).
9. No `CLAUDE.md`; no tests outside `_shared/jobsearch/*_test.ts`.
