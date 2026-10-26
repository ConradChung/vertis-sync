# Lume — command center over the vertis-sync pipelines

Adds `lume/`, a second, independent Next.js app (Vercel Root Directory `lume`)
that shows every open gate, order, campaign and rotation rule in one place and
lets the owner decide gates from the browser. It is a second door onto the
existing pipelines, not a new pipeline: decisions go through `telegram-inbox`
and race the Telegram buttons for the same claim; anything that spends or
sends is a `pending_actions` row that waits for Confirm (Lume) or Approve
(Telegram). Design: `docs/lume/2026-10-14-lume-design.md`; plan:
`docs/lume/2026-10-14-lume.md`; setup: `lume/README.md`.

Screens: Overview, Import (CSV / Apify / Apollo link), Validate (gate queue,
per-lead rows), Rotate (lead bank, rules), Campaigns (Instantly table, flow,
inbox), `/actions/<id>` (plan card), the orb agent (tiered tools, high-risk =
pending action only), and `/design` (every component in each state).

## New secrets (names only)

| Name | Where |
| --- | --- |
| `LUME_ALLOWED_EMAIL` | Vercel (lume) |
| `LUME_ACTION_SECRET` | Vercel (lume) **and** Supabase edge secret (`telegram-inbox`) |
| `LUME_URL` | Vercel (lume) **and** edge secret; also vault `lume_url` |
| `LUME_HOOK_SECRET` | Vercel (lume); same value in vault `lume_hook_secret` |
| `LUME_INTERNAL_SECRET` | Vercel (lume) — agent bearer + CSV upload-ticket HMAC |
| `INSTANTLY_WEBHOOK_SECRET` | Vercel (lume) |
| `INSTANTLY_API_KEY`, `ANTHROPIC_API_KEY`, `APIFY_API_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Vercel (lume) copies of existing values |
| `ROTATE_CAMPAIGN_ID` | Vercel (lume), optional |
| vault `lume_owner_email` | Supabase vault (RLS owner check) |

Root `.env.example` and `lume/.env.example` list every name; no values in the repo.

## Database (migrations)

| Migration | What |
| --- | --- |
| `20261014102012_lume_core` | Tables `events`, `pending_actions`, `agent_runs`, `rotation_rules`, `lume_campaigns`, `lume_external_schedules`; indexes incl. `events` webhook dedupe; owner read policies; `pending_actions` `updated_at` trigger; Realtime publication for `events`, `pending_actions`, `agent_runs` |
| `20261014103940_lume_core_fixes` | `lume_is_owner()` (JWT email vs vault `lume_owner_email`, default deny) behind the read policies; FKs `agent_runs` ↔ `pending_actions`; status check; extra indexes |
| `20261014203525_lume_views` | Views `lume_gates`, `lume_orders`, `lume_lead_bank`; functions `lume_overview()`, `lume_scheduled_jobs()`; `lead_bank` lower(email) index |
| `20261014204924_lume_views_fixes` | Revised `lume_gates` / `lume_overview()` / `lume_scheduled_jobs()`; `pending_actions` job index |
| `20261014210421_lume_triggers` | `lume_event_on_change()` triggers (`lume_events_*`) on `telegram_ingests`, `validation_jobs`, `apollo_orders`, `job_batches`, `lead_bank`, `rotation_runs`, `pending_actions`, `agent_runs`; `lume_gate_kind()` + `lume_gate_opened()` triggers (`lume_gate_*`) that pg_net-POST `lume_url/api/hooks/gate-opened`; **widens `telegram_ingests.sender_platform` check to `('telegram','slack','lume')`** |
| `20261014212712_lume_triggers_fixes` | Revised trigger functions, `lume_overview()`, `lume_scheduled_jobs()` |
| `20261014213932_lume_cron` | `lume_rotation_tick()` + pg_cron `lume-rotation-tick` (*/15, POSTs `lume_url/api/cron/rotation-tick`), `lume-events-purge` (events > 90 d), `cron-history-prune` (> 30 d) |
| `20261015071538_lume_events_webhook_index` | Unique `events_webhook_id_idx` |
| `20261016023010_lume_pending_actions_unique` | One awaiting action per kind per job |
| `20261025234511_lume_cron_fixes` | `lume_rotation_tick()` also fires for stale awaiting actions; one awaiting action per rule |
| `20261026000725_lume_pending_actions_campaign_unique` | One awaiting pause/resume per campaign; one awaiting `send_reply` per message |

All Lume hooks return silently until the vault entries exist. pgTAP:
`supabase/tests/lume_{core,views,triggers,cron}_test.sql`.

## The one existing function touched: `telegram-inbox`

Commits `81cb5c4`, `b282bcb`, `4ce5aed` (+216 / −1 vs `2e59cfb`). Additive:
every existing Telegram path behaves as before; new code runs only for a
request carrying `X-Lume-Secret` or for the new `lume_ok` / `lume_no`
callbacks. Shared helpers in `supabase/functions/_shared/lume/action.ts`
(allowlist, parser, constant-time compare; Deno tests). Insertion points:

1. **Request entry**, before the Telegram webhook-secret check: a request with
   `X-Lume-Secret` (= `LUME_ACTION_SECRET`, constant time; else 401) carries
   `{callback_data}`; it is parsed against the allowlist and fed to the
   existing `handleCallback`, so Lume uses the same conditional-PATCH claim as
   a tap. It reads the gate set before/after and answers
   `{ok, claimed: true|false|null}` (false = someone else already decided),
   and posts "decided in Lume" to the chat with a brake keyboard.
2. **`handleCallback` dispatch**: `lume_ok:<id>` / `lume_no:<id>` →
   `handleLumeActionCallback`, which claims the `pending_actions` row
   (awaiting → approved / rejected), edits the prompt, and on approve calls
   `LUME_URL/api/actions/<id>/execute` with `X-Lume-Secret` (in `waitUntil`).
   With `LUME_URL` unset it says so and executes nothing.
3. **`handleLfoCallback`**: a Lume-sent `lfo_count` may carry any count in
   500–50,000 (Telegram taps keep the fixed options).

Lume's own CSV / Apify / Apollo intakes insert `telegram_ingests`
(`sender_platform='lume'`) / `apollo_orders` and send telegram-inbox's own
prompt and keyboard; approval and everything after stays in telegram-inbox.

## Follow-ups folded in at the end

- CSV upload ticket is `<exp>.<HMAC(path|exp)>`, rejected after 15 min.
- Verified uploads rejected as too large / not CSV / empty, or whose ingest
  insert fails (except a duplicate key), are removed from Storage.
- `/api/import/csv` `maxDuration = 90` (the streamed scan alone may take 60 s).
- Name edits recognise `fname` / `lname` / `first` / `last` / `surname` /
  `organization` style headers.
- Parity test also covers `parseCSVRow`, `headerFromBytes`, `countDataRows`.

## Deferred

- Gmail sender + Pub/Sub push, Muse connector, Linear issues, Google Sheet
  status mirror, Slack outbound, per-campaign rotator (only the
  `instantly-rotate` campaign drains queued leads), light mode, read-only
  share link — stubs / "deferred" states in the UI.
- `telegram_ingests.storage_path` unique index (+ map 23505 → 409 in
  `/api/import/csv`).
- `raw-uploads` bucket `file_size_limit` 20 MB and CORS (owner step below).
- `telegram-inbox` `replyToSender` guard for `sender_platform='lume'` (needs a
  redeploy).
- Single-statement RPC for per-lead row edits (closes the ms gap between the
  edit's check and the validator starting).

## Manual acceptance — NOT YET RUN

- [ ] `supabase db reset && supabase test db` green.
- [ ] `cd supabase/functions && deno test _shared/` green; `deno check telegram-inbox/index.ts` clean.
- [x] `cd lume && npm run build && npx vitest run` green (run locally at the Task 15 commit; the only automated item already run).
- [ ] Real CSV → Validate → Approve in Lume → Telegram prompt edits → job runs → a stale Telegram tap is a no-op.
- [ ] Job-search batch Gate 1 decided from Lume, then a stale Telegram tap.
- [ ] Instantly webhook test event lands in the Overview feed.
- [ ] A rule tick creates a pending action and a Telegram prompt; approving from Telegram executes once; Lume's Confirm afterwards says already handled.
- [ ] `git log main..lume` shows one commit per task; nothing pushed.

## Owner steps before merge / deploy

1. Supabase Auth redirect allowlist: `http://localhost:3000/auth/callback` and `https://<lume host>/auth/callback`.
2. Create the owner auth user (`LUME_ALLOWED_EMAIL`).
3. `raw-uploads` bucket: 20 MB `file_size_limit`, CORS for the Lume origin; test a > 4.5 MB CSV.
4. Vercel project, Root Directory `lume`, env vars above; the `maxDuration = 300` routes need Fluid compute (Pro).
5. Edge secrets `LUME_ACTION_SECRET`, `LUME_URL`; redeploy `telegram-inbox` from disk (`deploy-functions.yml`).
6. Vault: `lume_url`, `lume_hook_secret`, `lume_owner_email`.
7. Register `https://<lume host>/api/webhooks/instantly?secret=<INSTANTLY_WEBHOOK_SECRET>` in Instantly.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
