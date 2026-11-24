# Feature map

What each real feature in this repo is, where it lives, how to test it and what
good looks like. The `verify-app` reviewer (`.claude/agents/verify-app.md`)
reads this to decide which checks a change needs. Built from the code on
2026-11-24; paths were checked to exist then.

**Marked _(guess)_:** anything that could not be run or confirmed in a sandbox
(live Supabase, deployed functions, Telegram, Instantly, Vercel). Confirm those
by hand or against the live project before relying on them.

The full suites per area are run by `.claude/hooks/require-checks.sh
--checks-only`; the "How to test" lines below are the targeted extras.

Baseline on main when this file was written: Lume lint, typecheck, 3,745
vitest tests and build all pass; root typecheck passes; root lint has ~50
older errors (so only changed files are linted); the Deno suite has 1 known
failure, `_shared/invoke_test.ts` flagging `instantly-push/index.ts:857`
(fixed by PR #2 / GTM-26).

---

## Cross-cutting rules (check on every change)

- **Every stage waits on a tap.** Anything that spends money or sends must go
  through a Telegram button, a Lume Confirm, or a `pending_actions` row.
  Exceptions are only the two CLAUDE.md names (GTM-14 comments lane,
  GTM-19 Hiring Ops Signal).
  _Test:_ `git diff $BASE | grep -nE 'fetch\(|activate|/campaigns/.*/(activate|pause)|send(Message|Email)'`
  and read each hit; `cd lume && npx vitest run tests/actions tests/approvals`.
  _Good:_ new outbound calls only run from an executed `pending_action` or a claimed gate.
- **Lume decides through `telegram-inbox`** (`X-Lume-Secret`, see
  `supabase/functions/telegram-inbox/index.ts` ~line 2049). Lume never PATCHes
  `validation_jobs` / `telegram_ingests` / `job_batches` state itself and never inserts `validation_jobs`.
  _Test:_ `git diff $BASE -- lume | grep -nE "validation_jobs|telegram_ingests|job_batches"`.
  _Good:_ reads only; writes go via `lume/app/api/gates/decide`.
- **Additive edge-function changes; deploy from disk only.** Never edit an
  applied migration (hard check in the hook). Secrets never in code (hard check).

---

## Lume (`lume/`, Next.js 15 command center)

### Gates and approvals
- **Where:** `lume/app/api/gates/decide`, `lume/app/api/actions/[id]/` (decide, execute),
  `lume/app/api/actions/pending`, `lume/lib/actions/`, `lume/lib/approvals/`,
  `lume/app/(app)/actions/`, `lume/app/(app)/validate/`; edge side
  `supabase/functions/_shared/lume/action.ts`.
- **How to test:** `cd lume && npx vitest run tests/actions tests/approvals tests/validate`;
  `cd supabase/functions && deno test --allow-env --allow-read _shared/lume/ telegram-inbox/`.
- **Good:** a decision is one conditional PATCH claim that Telegram and Lume
  race for; the loser gets nothing (no double execute). `/api/gates/decide`
  refuses `push_go`, `camp_launch`, `lume_ok`, `lume_no` with `needs_confirmation`.
  A pending action executes exactly once.

### Orb agent (chat, tools, projects, memory, skills)
- **Where:** `lume/lib/agent/`, `lume/app/api/agent/*`, `lume/app/(app)/agent/`.
- **How to test:** `cd lume && npx vitest run tests/agent tests/api/agentRun.test.ts`.
- **Good:** high-risk tools only create `pending_actions` (see
  `lume/lib/agent/permissions.ts`); no tool sends, pushes or spends directly.

### Lume MCP server
- **Where:** `lume/app/api/mcp/route.ts`, `lume/lib/mcp/`, policy `lume/lib/actions/mcpPolicy.ts`, doc `docs/lume/LUME-MCP.md`.
- **How to test:** `cd lume && npx vitest run tests/mcp` (`live.smoke.test.ts` needs the live DB _(guess: skipped without env)_).
- **Good:** read tools return `{"untrusted": …}` wrappers for third-party text;
  request tools only file pending actions; write tools touch only Lume's own rows; idempotency keys dedupe.

### Campaigns, Instantly and the lead bank / rotation
- **Where:** `lume/lib/campaigns/`, `lume/lib/rotation/`, `lume/lib/leads/`,
  `lume/app/api/campaigns/`, `lume/app/api/rotation/`, `lume/app/api/cron/rotation-tick`,
  `lume/app/(app)/campaigns/`, `lume/app/(app)/rotate/`; edge `supabase/functions/instantly-rotate/`, `instantly-push/`.
- **How to test:** `cd lume && npx vitest run tests/campaigns tests/rotation tests/leads tests/api/rotationTick.test.ts tests/api/campaignRoutes.test.ts`;
  `cd supabase/functions && deno test --allow-env --allow-read instantly-rotate/ instantly-push/`.
- **Good:** the rotation tick is notify-only (creates pending actions, never pushes);
  pushes, launches and pauses only happen after Confirm / `lume_ok`.

### Import (CSV, XLSX, Apify, Apollo link)
- **Where:** `lume/lib/import/`, `lume/lib/csv/`, `lume/app/api/import/{csv,xlsx,apify,apollo-link}`, `lume/app/(app)/import/`.
- **How to test:** `cd lume && npx vitest run tests/import tests/csv tests/api/importRoutes.test.ts tests/api/importXlsx.test.ts`.
- **Good:** an import lands as an ingest that waits for approval; it never creates `validation_jobs` directly.

### Influencer reactions and signals (GTM-10/14)
- **Where:** `lume/lib/influencers/`, `lume/lib/signal/`, `lume/app/api/influencers/*`,
  `lume/app/api/cron/signal-reactions`, `lume/app/api/cron/signal-alerts`, `lume/app/(app)/influencers/`;
  edge `supabase/functions/influencer-reactions/`, `influencer-lookup/`, `signal-comments/`, `_shared/influencer/`, `_shared/signal/`.
- **How to test:** `cd lume && npx vitest run tests/influencers tests/signal`;
  `cd supabase/functions && deno test --allow-env --allow-read _shared/influencer/ _shared/signal/ signal-comments/ influencer-reactions/ influencer-lookup/`.
- **Good:** the comments lane stays inside its caps ($10 Apify + $5 filter per
  cycle, $1 per PT day) and posts one #sales message when a cap hits; nothing is sent to leads.
  The reactions lane still files its Monday one-tap card.

### Hiring Ops Signal (GTM-19)
- **Where:** `lume/lib/hiring/`, `lume/app/api/signals/hiring`, `lume/app/api/cron/hiring-signal`, `lume/app/(app)/signals/hiring/`.
- **How to test:** `cd lume && npx vitest run tests/hiring`.
- **Good:** bounded by `lume_settings.hiring_signal_config` (lanes, per-run
  caps, $40/month); plain ticks start runs only when `schedule` is exactly
  `true`; only writes sheet rows, never emails. The cron migration is not applied without Conrad's say-so.

### Reddit signals (GTM-15, F5Bot emails)
- **Where:** `lume/lib/reddit/`, doc `docs/lume/f5bot-apps-script.gs`.
- **How to test:** `cd lume && npx vitest run tests/reddit`.
- **Good:** each F5Bot email is kept as received; cards carry the comment excerpt and a one-line summary.

### Company check and research crawl
- **Where:** `lume/lib/companyCheck/`, `lume/lib/crawl/`, `lume/app/api/company-check/route.ts`;
  edge `supabase/functions/company-check/`, `company-research/`, `_shared/company_check/`, `_shared/research/`; worker `workers/crawl/`.
- **How to test:** `cd lume && npx vitest run tests/companyCheck tests/crawl`;
  `cd supabase/functions && deno test --allow-env --allow-read company-check/ company-research/ _shared/research/ _shared/company_check/`;
  crawl worker `cd workers/crawl && python -m pytest tests -q` (needs its venv).
- **Good:** failed Apify/Haiku runs are recorded as failed with their real cost; no extraction from a failed run.

### CRM, inbox and replies
- **Where:** `lume/lib/crm/`, `lume/lib/inbox/`, `lume/app/api/crm/*`, `lume/app/api/inbox/*`,
  `lume/app/api/webhooks/instantly`, `lume/app/(app)/crm/`; docs `docs/lume/INBOX-MANAGER-*.md`.
- **How to test:** `cd lume && npx vitest run tests/crm tests/inbox tests/webhooks tests/api/crmRoutes.test.ts tests/api/inboxWrite.test.ts`.
- **Good:** replies are pending actions until confirmed; the Instantly webhook
  checks `?secret=`, refuses bodies over 128 KB and dedupes on `webhook_id`.

### Operators, client portal and Slack client
- **Where:** `lume/lib/operators/`, `lume/lib/portal/`, `lume/lib/slack/`,
  `lume/app/api/operators`, `lume/app/api/portal/*`, `lume/app/api/slack/*`,
  `lume/app/(app)/operator/`, `lume/app/(portal)/portal/`.
- **How to test:** `cd lume && npx vitest run tests/operators tests/portal tests/slack`.
- **Good:** an operator or portal user only sees their own zone/leads (masking holds);
  Slack events verify signatures _(guess: check `lume/lib/slack/` before relying on it)_.

### Auth and middleware
- **Where:** `lume/middleware.ts`, `lume/lib/auth/`, `lume/app/login/`, `lume/app/auth/`.
- **How to test:** `cd lume && npx vitest run tests/auth tests/api/routeGuards.test.ts`.
- **Good:** only `LUME_ALLOWED_EMAIL` signs in; every page and API route is owner-gated
  except the secret-checked hooks, webhooks, cron and MCP routes.

### Overview, alerts, health, settings, calendar/tasks, progress, playground
- **Where:** `lume/lib/{overview,alerts.ts,health,settings,tasks,schedule,progress,playground}`,
  matching `lume/app/(app)/*` pages; Linear sync via `LINEAR_API_KEY`.
- **How to test:** `cd lume && npx vitest run tests/overview tests/alerts tests/health tests/settings tests/tasks tests/schedule tests/progress tests/playground`.
- **Good:** missing env (Instantly, Linear, Telegram) degrades to a banner or no-op with a warning, never a crash.

### UI components and `/design`
- **Where:** `lume/components/`, `lume/app/design/`.
- **How to test:** `cd lume && npx vitest run tests/components` and `npm run build`.
- **Good:** builds; component tests pass in jsdom. Visual checks need a browser _(guess: not covered by the hook)_.

---

## Edge functions (`supabase/functions/`, Deno)

### Telegram / Slack decision inbox
- **Where:** `telegram-inbox/index.ts` (every gate's entrypoint; `handleCallback`), `slack-inbox/index.ts` (intake only).
- **How to test:** `cd supabase/functions && deno test --allow-env --allow-read telegram-inbox/ slack-inbox/ && deno check telegram-inbox/index.ts`.
- **Good:** answer callback → conditional PATCH with `return=representation` →
  zero rows means someone else won, return silently → strip keyboard → invoke the worker.

### CSV validation pipeline (finder → validator → enricher → push)
- **Where:** `contact-email-finder/`, `email-validator/`, `operating-city-enricher/`, `instantly-push/`, `pipeline-watchdog/`, `_shared/{eta,backoff,pool,invoke,pacer}.ts`.
- **How to test:** `cd supabase/functions && deno test --allow-env --allow-read email-validator/ operating-city-enricher/ instantly-push/ pipeline-watchdog/ _shared/`.
- **Good:** workers self-reinvoke under the 110 s budget and every
  function-to-function fetch is awaited or `keepAlive`d (`_shared/invoke_test.ts`);
  the watchdog only pings, never resumes on its own.

### HNWI / RIA wealth pipeline
- **Where:** `hnwi-pipeline-orchestrator/`, `hnwi-email-finder/`; root route `app/api/validate/hnwi/start/route.ts`.
- **How to test:** no tests exist for these two functions; `deno check hnwi-pipeline-orchestrator/index.ts hnwi-email-finder/index.ts` and read the diff. _(guess: behaviour only verifiable live)_
- **Good:** creates its four validation jobs with `source='hnwi'`; deploys with `--no-verify-jwt`.

### Leadsfriday order (Apollo link → CSV)
- **Where:** `leadsfriday-order/`; intake in `telegram-inbox` (`handleApolloOrPasteText`).
- **How to test:** `cd supabase/functions && deno test --allow-env --allow-read leadsfriday-order/`.
- **Good:** the order spends credits only after the count is confirmed in Telegram; the delivery becomes an ingest awaiting approval.

### Job-search pipeline (batches, puller, sheet writer)
- **Where:** `jobsearch-notify/`, `jobsearch-puller/`, `jobsearch-sheet-writer/`, `_shared/jobsearch/`;
  root `components/JobSearchPanel.tsx`, `app/api/jobsearch/batches/`; design `docs/plans/2026-10-09-jobsearch-pipeline*.md`.
- **How to test:** `cd supabase/functions && deno test --allow-env --allow-read _shared/jobsearch/`.
- **Good:** Gate 1 (pull/skip) and Gate 2 (write) are claim-guarded; nothing reaches Instantly.
  (Conrad's newer job hunt app lives in its own Supabase project and repo, not here.)

### Config health
- **Where:** `config-health/`.
- **How to test:** `cd supabase/functions && deno test --allow-env --allow-read config-health/`.
- **Good:** reports secret names that are missing, never their values.

---

## NorthStar CRM (root Next.js 16 app)

### Validation dashboard and Apify / HNWI starts
- **Where:** `components/EmailValidator.tsx`, `app/email-validator/`, `app/api/validate/{start,status,results,apify/start,hnwi/start}/route.ts`, `app/api/instantly/{campaigns,push}/route.ts`.
- **How to test:** no automated tests in the root app. Root typecheck + lint of changed files (the hook runs both); read the diff against the gate rules.
- **Good:** `/api/instantly/push` POST requires `status=completed` and refuses if already `pushing`.

### Admin / client CRM, onboarding, AI generators, analytics
- **Where:** `app/admin/`, `app/dashboard/`, `components/{AdminDashboard,ClientDashboard,onboarding/*,CopywriterAgent,ClayPromptGenerator,MarketResearchAgent,CampaignAnalytics}.tsx`,
  `app/api/{generate-copy,generate-clay-prompts,generate-domains,market-research,analytics,onboarding,client-attachments,client-snapshot,replies,save-pdf}/`, `lib/instantly.ts`.
- **How to test:** typecheck + changed-file lint only; no tests exist. _(guess: behaviour needs a browser and the live DB)_
- **Good:** compiles; no new lint errors in touched files.

---

## Database (`supabase/migrations/`, `supabase/tests/`)

- **Where:** migrations (Lume's are `*_lume_*.sql`); pgTAP tests `supabase/tests/lume_*_test.sql`.
- **How to test:** `supabase test db` (needs the Supabase CLI and a local stack; not available in cloud sessions, so the hook skips it). Apply via Supabase MCP `apply_migration`, then name the file after the ledger version (`list_migrations`).
- **Good:** new migrations only (never an edit; the hook blocks that); a `_fixes`
  migration for corrections; RLS/owner checks covered by a pgTAP test when they change.

## Crawl worker (`workers/crawl/`, Python, Railway)
- **Where:** `workers/crawl/app.py`, `classify.py`.
- **How to test:** `cd workers/crawl && python -m pytest tests -q` (unit; needs `requirements-dev.txt`); live test only with `RUN_LIVE=1`.
- **Good:** unit tests pass with no network.
