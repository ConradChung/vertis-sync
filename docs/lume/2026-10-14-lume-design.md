# Lume — Command center over the outbound pipelines

**Date:** 2026-10-14
**Status:** Draft for review (Step 0 output; nothing implemented yet)
**Spec:** `docs/lume/SPEC.md` · **Inventory:** `docs/lume/INVENTORY.md` · **Look:** `docs/lume/reference/`

## Overview

Lume is a second Next.js app in this repo (`lume/`) that sits over every table and edge function the pipelines already use. It adds a screen for each stage of a lead's life (Overview, Import, Validate, Rotate, Campaigns), an agent behind the orb, and a handful of its own tables for what nothing in the repo holds today: an append-only `events` feed, `pending_actions` for high-risk approvals, `agent_runs`, `rotation_rules`, and `lume_campaigns`.

It never bypasses a gate. Every button in Lume lands on the **same conditional PATCH** the Telegram button lands on, through one additive entrypoint on `telegram-inbox`, so a tap in Telegram and a tap in Lume race for the same row and exactly one wins. Every decision made in Lume is also posted to the Telegram chat, and every gate Lume shows gets a Telegram ping with a deep link into the Lume screen. Nothing auto-pushes to Instantly and nothing sends email without a confirmation that creates, and then resolves, a `pending_actions` row.

Out of scope for this pass (named in SPEC.md, nothing in the repo supports them): the Gmail API sender and Pub/Sub push, the Muse connector, Linear issue creation, the Google Sheet status mirror, the Slack outbound Kaspen channel, light mode, the read-only share link. They appear in the design as adapter stubs with a clear "deferred" state so the screens render honestly.

---

## Architecture

```
                 ┌──────────────── Vercel: lume/ (Next 15, App Router) ────────────────┐
browser ──auth──▶│ screens ── hooks (useOverview, useOrders, useValidationQueue,         │
  (magic link,   │            useRotation, useCampaigns) ── /api/* route handlers        │
   one email)    │ Realtime: events, pending_actions                                      │
                 │ orb ── /api/agent/run (Claude tool use; tools = fetch(/api/*))          │
                 └───────┬───────────────────────────┬──────────────────────────┬────────┘
                         │ service role               │ X-Lume-Secret            │ Instantly REST
                         ▼                            ▼                          ▼
   Supabase ─ views lume_gates / lume_orders / lume_lead_bank / lume_scheduled_jobs()
            ─ new tables events, pending_actions, agent_runs, rotation_rules, lume_campaigns
            ─ triggers: status change → events row; gate opens → net.http_post → Lume ping
            ─ pg_cron lume-rotation-tick → net.http_post → /api/cron/rotation-tick
                         │
                         ▼
   telegram-inbox (ADDITIVE) ── POST {lume_action} → handleCallback(same code) → same PATCH → same invoke
                              ── lume_ok:<id> / lume_no:<id> → pending_actions claim → POST /api/actions/<id>/execute
   every other edge function: UNCHANGED (events come from triggers, not from their code)
```

### Why one entrypoint instead of copying the claims into Lume

`app/api/jobsearch/batches/[id]/action/route.ts` copies the PATCH filters from `telegram-inbox`. That works for claim-only actions, but `approve:` / `approve_enrich:` do real work after the claim (download the CSV from `raw-uploads`, chunk-insert `validation_rows`, decide on the finder prompt, quote the ETA). Copying that into Lume means two implementations of the intake. Instead, `telegram-inbox` gets a second way in: a `POST` carrying `X-Lume-Secret: $LUME_ACTION_SECRET` and `{ "callback_data": "approve:<ingest_id>", "origin": "lume" }`. The handler runs `handleCallback` with a synthetic callback object (`id: ''`, no `message`). Two guards make that safe: `tg('answerCallbackQuery', …)` is skipped when the id is empty, and every `editMessageText` already checks `cb.message` / the stored `telegram_message_id`. When the Telegram message id was never stored (finder prompt, watchdog prompts, Gate 2, the barrier screens), the stale Telegram button stays on screen and a later tap hits a claim that returns zero rows, which is the existing "already handled" no-op. After the handler returns, the entrypoint posts `🖥 <action> — decided in Lume` to the chat so the thread keeps the history.

This is additive: the webhook branch, the secret check, and every existing handler body are untouched. The deploy path is the existing workflow (`telegram-inbox` is already in the `--no-verify-jwt` deploy line).

### Why triggers for the events feed

The spec's `events` table must see every stage transition, including the ones made from Telegram while Lume is closed. Inserting from 14 edge functions means 14 edits to code the prompt says not to change. `AFTER INSERT OR UPDATE` triggers on `validation_jobs`, `telegram_ingests`, `job_batches`, `apollo_orders`, `lead_bank`, `rotation_runs` write one `events` row per status-column change, with zero function edits, and they also catch Telegram-made decisions, dashboard-made decisions and watchdog claims. Things no table records (Instantly webhooks, agent tool calls, Lume decisions) are written by Lume's own routes through a single `logEvent()` helper.

The same mechanism delivers the "every gate pings Telegram with a deep link" rule without touching the functions that send the gate messages: a trigger fires `net.http_post` to Lume's `/api/hooks/gate-opened` (pg_net is already installed and used by the watchdog cron; the vault already holds `project_url` / `service_role_key`, and gains `lume_url` / `lume_hook_secret`). Lume then sends a second, short Telegram message: `🔗 Open in Lume → https://<host>/validate?gate=ingest_approval:<id>`.

---

## Screens → existing tables and functions

Spec table names on the left; what Lume actually reads and writes on the right. Only the five tables marked **new** are created.

| Spec concept | Repo reality | Lume object |
|---|---|---|
| `orders` | `apollo_orders` (Apollo link → Leadsfriday), `telegram_ingests` (CSV via Telegram / Slack / Leadsfriday delivery / Lume), `validation_jobs` with `source in (apify, hnwi, csv)` (dashboard-originated), `job_batches` (Leadsfriday job-search order) | **view `lume_orders`** (union, one row per pull: `source`, `kind`, `status`, `row_count`, `cost_usd` from `apollo_orders.credits_deducted`, `created_by`) |
| `validation_items` | No per-lead verdict table exists. Gates are per batch: `telegram_ingests.status`, `validation_jobs.finder_status / instantly_status / watchdog_status`, `job_batches.review_status / write_status / watchdog_status / status=waiting_fill`, `apollo_orders.count_status` | **view `lume_gates`** (one row per open gate with `kind`, `target_table`, `target_id`, `actions[]`, counts, `telegram_message_id`); per-row detail straight from `validation_rows` |
| `campaigns` | `campaigns` already exists (CRM client assignment). Instantly campaigns live only in Instantly; the Gmail recruiter campaign and Muse have no table | **new table `lume_campaigns`** (`family`, `name`, `external_id`, `sender_type instantly/gmail/muse`, `status`, `capacity_per_day`, `instantly jsonb`), synced from Instantly `GET /campaigns`; gmail/muse rows seeded by hand |
| `rotation_rules` | Nothing. `instantly-rotate` has a hard-coded campaign and cap | **new table `rotation_rules`** + pg_cron `lume-rotation-tick` → Lume route; a due rule creates a `pending_actions` row, never pushes |
| `events` | Nothing (`rotation_runs` is per rotation run, `ai_runs` is AI-tool output) | **new table `events`**, written by triggers + Lume routes, in `supabase_realtime` |
| `agent_runs` | Nothing | **new table `agent_runs`** |
| (implied) approvals for high-risk actions | Nothing for Lume/agent-originated actions | **new table `pending_actions`** with `claim_status` (same claim pattern), Telegram buttons `lume_ok:<id>` / `lume_no:<id>` |
| `scheduled_jobs` | `cron.job` (4 jobs) + Claude scheduled tasks outside the repo | **function `lume_scheduled_jobs()`** (SECURITY DEFINER over `cron.job` + `cron.job_run_details`) UNION **new table `lume_external_schedules`** (manual registry: job scrape, PM reactions, HNWI, Vercel crons) |
| lead bank | `lead_bank` (rotation campaign) + `validation_rows` `status=valid`, `instantly_status=skipped` on `completed` jobs | **view `lume_lead_bank`** |

### 1. Overview

| Element | Source |
|---|---|
| KPI "Sent today" | Instantly `GET /campaigns/analytics/daily` summed over `lume_campaigns` where `sender_type=instantly` (route `/api/instantly/analytics`, cached 60 s). Gmail/Muse contribute 0 with a "not connected" tooltip |
| KPI "Replies today" | `events` where `type in (reply)` today (Instantly webhook) |
| KPI "Pending approvals" | `count(*) from lume_gates` (badge jumps to Validate) |
| KPI "Open opportunities" | Instantly analytics `total_opportunities`; `$` only if a per-campaign value is set on `lume_campaigns.opportunity_value_usd` (nullable, defaults to hiding the figure) |
| Live reply feed | `events` Realtime subscription, `type in (reply, interested, bounce)`; "Open ↗" to `https://app.instantly.ai/app/unibox?…` using `payload.lead_email`. Instantly webhooks → `/api/webhooks/instantly` (secret in query) → `events`. Gmail push and Telegram-posted replies: deferred stubs |
| Per-campaign strip | `lume_campaigns` + Instantly `analytics/overview`; health dot: red when `events` has ≥ 5 bounces for the campaign in 24 h or an account is `warmup_status != active`, amber when reply rate < 1 %, else green |
| Inbox health | Instantly `GET /accounts` (warmup status, daily limit, `stat_warmup_score`); route `/api/instantly/accounts` |
| Next runs | `lume_scheduled_jobs()` with `next_run` computed client-side from the cron expression (`cron-parser`) |
| Agent activity | `events` where `type like 'agent.%'` + `agent_runs` |

### 2. Import & Orders

| Action | Path |
|---|---|
| Apify pull (dataset id or actor's last run) | `/api/import/apify` fetches items, writes a CSV to `raw-uploads/lume/<uuid>.csv`, inserts a `telegram_ingests` row (`sender_platform='lume'`, `sender_chat_id=TELEGRAM_CHAT_ID`), sends the **same** `📥 New CSV … [Approve] [Approve + Enrich] [Deny]` Telegram prompt (`approve:<id>` etc.), stores `telegram_message_id`. From here the existing approval pipeline owns it. **Additive constraint change:** `telegram_ingests.sender_platform` gains `'lume'` |
| CSV upload | same route family (`/api/import/csv`), same ingest row, same prompt. (The admin dashboard's `/api/validate/start` skips the gate; Lume does not.) |
| Apollo link | `/api/import/apollo-link` inserts `apollo_orders(status awaiting_count)` and sends the same `🔗 Apollo search received` prompt with the `lfo_*` keyboard. Picking a count in Lume calls the `telegram-inbox` entrypoint with `lfo_count:<id>:<n>`; the entrypoint accepts any `n ≥ 500` when `origin='lume'` (presets stay the rule for real Telegram taps). That claims `count_status` and invokes `leadsfriday-order`, the puller's own order/poll code |
| Orders table | `lume_orders` |
| Right rail | raw sample = first 5 `validation_rows.row_data` (or first 5 CSV lines from Storage for an unapproved ingest); enrichment config shows `validation_jobs.enrich / icp_filter / icp_description` read-only until approval (the choice is made by the Approve vs Approve + Enrich tap, as today) |
| "Schedule this pull" | inserts `lume_external_schedules` row + instructions; actual scheduling of Apify runs stays with the Claude scheduled tasks (deferred: a Lume-owned Vercel cron) |

### 3. Validate

The approval queue is `lume_gates`, grouped by `kind`:

| `kind` | Rows | Buttons (same `callback_data` as Telegram) |
|---|---|---|
| `ingest_approval` | `telegram_ingests.status='awaiting_approval'` | Approve `approve:` · Approve + Enrich `approve_enrich:` · Deny `deny:` |
| `finder_decision` | `validation_jobs.finder_status='awaiting_decision'` | Find them first `finder_go:` · Validate only `finder_skip:` |
| `campaign_choice` | `validation_jobs.instantly_status in (awaiting_campaign, choosing_campaign)` | pick from `/api/instantly/campaigns` → `/api/gates/campaign/<job>` writes `instantly_campaign_id/_name` (the dashboard already does this in `/api/instantly/push`), then shows the barrier screen in Lume |
| `push_review` | `validation_jobs.instantly_status in (configuring, reviewing_company)` | barriers `bar_loc:` `bar_co:`, preview via `instantly-push mode:'preview'`, names mode `push_strict:` / `push_std:`, **Push these** → creates `pending_actions(kind='push_to_instantly')` (high-risk) → on confirm the executor runs `push_go:<job>` through the entrypoint · Cancel `push_cancel:` |
| `stall` | `validation_jobs.watchdog_status='awaiting'` | Resume `wd_resume:` |
| `jobs_review` | `job_batches.status='awaiting_review' and review_status='awaiting'` | Reviewed, pull `jobs_pull:` · Skip `jobs_skip:` |
| `jobs_fill` | `job_batches.status='waiting_fill'` | Order anyway `jobs_order_now:` · Abort `jobs_abort:` |
| `jobs_write` | `job_batches.status='ranked' and write_status='awaiting'` | Write to gtm `jobs_write:` · Discard `jobs_discard:` |
| `jobs_stall` | `job_batches.watchdog_status='awaiting'` | Resume `jobs_resume:` · Abort `jobs_abort:` |
| `lfo_count` | `apollo_orders.status='awaiting_count' and count_status='awaiting'` | 500 / 1000 / 2000 / 5000 / custom `lfo_count:` · Cancel `lfo_cancel:` |
| `lume_action` | `pending_actions.status='awaiting'` | Confirm / Cancel → `/api/actions/<id>/decide` |

Keyboard: `J`/`K` move between gates, `A` = first (approve-like) action, `R` = reject-like action, `E` = open the row editor. Email verification is the progress panel inside a job row (`processed_rows / total_rows`, `valid / invalid / error / no_email` counts, `eta_seconds`), not the screen.

The per-lead table under a job reads `validation_rows` (paged, 100 at a time, `order=row_index`) with `status`, `validation_result->>message`, `enrichment_status`, `row_data->>icp_status`, `instantly_status`. Inline edit (`E`) is allowed only on rows still `pending` (edits `row_data` and `email` before the validator reaches them; low-risk, logged to `events`).

Decisions go through `POST /api/gates/decide { callback_data }` → `telegram-inbox` entrypoint. The route re-reads `lume_gates` afterwards: if the same gate is still open the claim lost (`409 already handled`), which is the Telegram double-tap no-op seen from the other side.

### 4. Rotate (Lead Rotation Hub)

| Element | Source |
|---|---|
| Lead bank | `lume_lead_bank`: `lead_bank` rows in `queued` plus `validation_rows` that are `valid`, `instantly_status='skipped'`, job `completed`, not already in `lead_bank` by email. Filters: source (`validation_jobs.source` / `lead_bank`), ICP (`row_data->>icp_status`), geography (`row_data->>operating_city` / `lead_bank.location`), date |
| Campaign cards | `lume_campaigns`; capacity = Instantly `daily_limit` × accounts; queue depth = `lead_bank` `queued` for that `campaign_id` |
| Drop to assign | creates `pending_actions(kind='assign_leads', payload {campaign_id, lead_ids or filter, count})` + Telegram ping. On confirm the executor inserts `lead_bank` rows with `state='queued'` for that `campaign_id` (`unique(campaign_id, email)` makes it idempotent). For the rotation campaign the existing `instantly-rotate` cron drains them, unchanged. For any other campaign the rows sit queued and the card says "no rotator for this campaign yet" (deferred: generalise `instantly-rotate` per campaign) |
| Rules | `rotation_rules` (`name, campaign_id, filter jsonb, daily_cap, order_by, cron, active, next_run_at, last_run_at, last_result jsonb`). pg_cron `lume-rotation-tick` (every 15 min) → `lume_rotation_tick()` → `net.http_post` `/api/cron/rotation-tick`. The route finds due rules, counts candidates, creates one `pending_actions(kind='assign_leads')` per rule and pings Telegram. Failures: `last_result.error` + Telegram, no retry, no push (notify-only, like the watchdog) |
| Right rail | Instantly `GET /campaigns/{id}` sequences (first 3 steps), or `campaign_templates.sequences` for a campaign with none; Gmail template placeholder for the recruiter campaign |

### 5. Campaigns

| Tab | Source |
|---|---|
| Table | `lume_campaigns` joined to Instantly `analytics/overview` per campaign (sent, replies, opportunities), `events` for last activity |
| Analytics | `lib/instantly.ts` port: `getDailyAnalytics`, `getStepAnalytics` → Recharts stacked area, 7d / 30d |
| Flow | React Flow nodes Import → Validate → Enrich → Push → Send → Reply. Counts per campaign: `validation_jobs` where `instantly_campaign_id = external_id` (rows loaded, valid, enriched, `instantly_pushed`), Instantly sent/replies. "Run stage" on Import opens the Import screen pre-filled; on Validate/Enrich/Push it opens the matching gate if one is open, otherwise it is disabled with the reason (stages only run through gates). "Duplicate campaign" creates a `pending_actions(kind='create_campaign')` that on confirm calls Instantly `POST /campaigns` mirroring `email_list / campaign_schedule / daily_limit` (the pattern `createNoLocationCampaign` already uses) |
| Inbox | Instantly `GET /emails?campaign_id=…` threads; reply box → `pending_actions(kind='send_reply')` → on confirm `POST /emails/reply` with the matching `eaccount`. Gmail threads: deferred stub |

### The orb

`agent_runs` drives orb state: `running` → thinking, a tool executing → acting, `needs_approval` → amber ring, `done`/`failed` → idle. Voice input via Web Speech API (Chrome), transcript in the glass sheet. The reference `orb.tsx` (react-three-fiber + drei `MeshTransmissionMaterial`) is mounted as-is in the top bar.

Agent: `@anthropic-ai/sdk` Tool Runner (`client.beta.messages.toolRunner` + `betaZodTool`), model `claude-opus-5-5` (owner decision 2026-10-14; the spec said Sonnet), adaptive thinking (default), streaming to the sheet over SSE. Tools are thin `fetch()` wrappers over Lume's own `/api/*` routes with an internal bearer, never Supabase or Instantly directly:

| Tier | Tools | Behaviour |
|---|---|---|
| read | `list_orders`, `get_validation_queue`, `list_campaigns`, `campaign_stats`, `list_rules`, `list_scheduled_jobs`, `inbox_health` | run, log to `agent_runs.tool_calls` and `events` |
| low-risk write | `create_order` (Apify / CSV / Apollo link → creates the ingest + Telegram prompt, nothing runs), `draft_reply` (text only), `create_rotation_rule` with `active=false`, `notify` (Telegram text) | run, log |
| high-risk | `decide_validation` (any gate button), `assign_leads`, `activate_rule`, `send_reply`, `pause_campaign`, `resume_campaign`, `activate_campaign`, `duplicate_campaign`, `delete_*` | do **not** execute: create `pending_actions(requested_by='agent', agent_run_id)`, return `{status:'awaiting_approval', action_id}` to the model, mark the run `needs_approval`, Telegram message with `lume_ok:` / `lume_no:` and a deep link |

A confirmed action executes exactly what the UI button would have done (same executor module), so there is one code path per high-risk action whether it came from a click, the agent, or Telegram.

---

## Data model (new objects only)

```sql
events (id bigserial, type text, source text, source_id text, campaign_id text,
        lead_email text, title text, payload jsonb, created_at timestamptz)
pending_actions (id uuid, kind text, payload jsonb, risk text default 'high',
        status text awaiting|approved|rejected|executed|failed|expired,
        claim_status text awaiting|claimed,           -- the atomic-claim slot
        requested_by text user|agent, agent_run_id uuid, telegram_message_id bigint,
        decided_via text lume|telegram, decided_at, result jsonb, error text, created_at)
agent_runs (id uuid, prompt text, status text running|needs_approval|done|failed,
        plan jsonb, tool_calls jsonb, approval_action_id uuid, outcome text,
        model text, usage jsonb, created_at, finished_at)
rotation_rules (id uuid, name, campaign_id text, filter jsonb, daily_cap int, order_by text,
        cron text, active bool, next_run_at, last_run_at, last_result jsonb, created_at)
lume_campaigns (id uuid, family text kaspen|recruiter|muse|other, name, external_id text,
        sender_type text instantly|gmail|muse, status text, capacity_per_day int,
        opportunity_value_usd numeric, instantly jsonb, synced_at, created_at)
lume_external_schedules (id uuid, name, cron text, target text, runner text claude|vercel|other,
        last_status text, last_run_at, notes)
```

Views / functions: `lume_gates`, `lume_orders`, `lume_lead_bank`, `lume_scheduled_jobs()`, `lume_overview()`.
Triggers: `lume_event_on_change()` on the six pipeline tables; `lume_gate_opened()` (pg_net POST) on `telegram_ingests`, `validation_jobs`, `job_batches`, `apollo_orders`, `pending_actions`.
Constraint change: `telegram_ingests.sender_platform` check gains `'lume'`.
Realtime: `events`, `pending_actions`, `agent_runs` added to `supabase_realtime`.
RLS: on for all new tables; `authenticated` may `select` on `events`, `pending_actions`, `agent_runs` (the one allowed user, for Realtime); all writes through the service role.
Vault: `lume_url`, `lume_hook_secret` (used by the trigger and the cron tick).

---

## Changes to existing code (all additive)

| File | Change | Why additive |
|---|---|---|
| `supabase/functions/telegram-inbox/index.ts` | new branch in `Deno.serve`: `X-Lume-Secret` header → `handleLumeAction()`; `tg()` skips `answerCallbackQuery` with an empty id; `lfo_count` accepts any `n ≥ 500` when `origin='lume'`; new `lume_ok:` / `lume_no:` callbacks → claim `pending_actions` and POST `/api/actions/<id>/execute`; a `🖥 decided in Lume` note after a Lume-originated action | new header path and new callback prefixes; every existing branch and message is byte-identical |
| `supabase/migrations/2026101400000[1-4]_lume_*.sql` | new tables, views, triggers, cron, the `sender_platform` constraint | no existing column or row changes; the constraint only widens |
| `.env.example` | names of the new secrets + the five missing existing ones | comments only |
| `.github/workflows/deploy-functions.yml` | none | `telegram-inbox` is already deployed from disk |
| `CLAUDE.md` | new file with a Lume section | — |

Not changed: `email-validator`, `contact-email-finder`, `operating-city-enricher`, `instantly-push`, `instantly-rotate`, `pipeline-watchdog`, `jobsearch-*`, `leadsfriday-order`, `slack-inbox`, `hnwi-*`, every existing migration, the admin dashboard.

---

## Secrets

| Name | Where | Purpose |
|---|---|---|
| `LUME_ACTION_SECRET` | edge secret + Vercel (lume) | Lume → `telegram-inbox` entrypoint, and `telegram-inbox` → Lume `/api/actions/*/execute` |
| `LUME_HOOK_SECRET` | vault (`lume_hook_secret`) + Vercel | DB triggers / cron → Lume hooks |
| `LUME_URL` | edge secret + vault (`lume_url`) | where `telegram-inbox` and pg_net POST |
| `LUME_ALLOWED_EMAIL` | Vercel | the one magic-link login |
| `LUME_INTERNAL_SECRET` | Vercel | agent tools → Lume's own routes |
| `INSTANTLY_WEBHOOK_SECRET` | Vercel | `/api/webhooks/instantly?secret=` |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Vercel (already edge secrets) | Lume's own pings, deep links, decision notes |
| `ANTHROPIC_API_KEY`, `INSTANTLY_API_KEY`, `APIFY_API_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_*` | Vercel (already exist for the root app) | reused |

Deep-link format: `https://<LUME_URL>/validate?gate=<kind>:<target_id>` and `https://<LUME_URL>/actions/<pending_action_id>`.

---

## Security

- Single user: Supabase Auth magic link; `lume/middleware.ts` refuses any session whose email ≠ `LUME_ALLOWED_EMAIL`. Route handlers check the same before touching the service role. The browser never sees the service role key; Realtime uses the anon key under the authenticated user with `select` policies on the three new tables only.
- Entrypoints are shared-secret, not JWT: `telegram-inbox` already runs with `verify_jwt=false` and verifies callers itself; the Lume branch verifies `X-Lume-Secret` with a constant-time compare. Lume's hook and execute routes do the same.
- The RLS advisory (11 pipeline tables without RLS) is pre-existing and out of scope; Lume does not add anon access to anything.
- The agent never holds credentials; tools call Lume routes with `LUME_INTERNAL_SECRET`, and high-risk tools cannot execute at all.

## Error handling / edge cases

- Lume tap vs Telegram tap: same claim, zero rows → Lume shows "already handled" and refreshes; Telegram's `answerCallbackQuery` already said so on its side.
- Entrypoint unreachable: Lume shows the error, nothing was claimed, the Telegram button still works.
- Gate-opened hook fails (Lume down): the trigger's `net.http_post` is fire-and-forget; the original Telegram prompt was already sent by the pipeline, so the owner still has a button. No retry queue in v1.
- Rotation tick with Lume down: pg_net POST fails silently; the rule's `next_run_at` is not advanced, so the next tick retries. A rule that errors inside Lume writes `last_result.error`, pings Telegram, and does not create an action.
- Pending action approved from both Lume and Telegram: `claim_status` claim, one executes.
- Pending action older than 24 h: the rotation tick route also expires stale actions (`status='expired'`) and notes it in `events`.
- Instantly webhook replay: `events` has a unique partial index on `(type, payload->>'id')` for webhook events.

## Testing

- `supabase db reset` applies the four migrations on a fresh local stack; pgTAP tests under `supabase/tests/` assert the views return the expected rows from seeded fixtures (`lume_gates` for each `kind`, `lume_orders` union, `lume_lead_bank` exclusion of already-banked emails, trigger writes one event per status change).
- Vitest in `lume/`: agent tool tiering (read runs, low-risk runs, high-risk creates a pending action and never calls its route), the `lume_gates` → button mapping, cron next-run computation.
- Deno test for the pure `parseLumeAction()` helper in `telegram-inbox`.
- Manual (per the prompt): one real ingest → Validate → Approve in Lume → Telegram message edits → job advances → stale Telegram tap is a no-op; repeat for a job-search batch; Instantly webhook test event → Overview feed.

## Open questions for review

1. **Entrypoint vs copied claims** — the design uses one additive entrypoint on `telegram-inbox` for all gates. The alternative is to copy the PATCH filters into Lume routes (as the jobsearch route does) and only call the entrypoint for `approve*`. Recommendation: entrypoint everywhere.
2. **Triggers vs helper inserts for `events`** — triggers touch no function code; the prompt allowed helper inserts. Recommendation: triggers.
3. **Model for the orb agent** — decided: `claude-opus-5-5` (owner, 2026-10-14). Decisions 1, 2, 4, 5 accepted as recommended.
4. **Lume-side Telegram token on Vercel** — needed for deep-link pings and decision notes. The alternative routes every ping through `telegram-inbox`; more edge code, fewer places with the token.
5. **Assigning to non-rotation Instantly campaigns** — v1 queues them in `lead_bank` and says so; generalising `instantly-rotate` per campaign is a separate change to a function the prompt says not to touch.
