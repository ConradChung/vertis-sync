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
vitest tests and build pass (the reviewer saw one unnamed vitest failure in 4
runs, so the hook retries vitest once and names any flaky test it finds);
root typecheck passes; root lint has ~50 older errors (so only changed files
are linted); the Deno suite has 1 known failure, `_shared/invoke_test.ts`
flagging `instantly-push/index.ts:857` (fixed by PR #2 / GTM-26). The hook
reports edge failures that main also has as notes, not failures, so this one
stops blocking by itself once #2 merges.

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

### Google Maps lane (GTM-12)
- **Where:** `lume/lib/maps/`, `lume/app/api/maps/{scrape,sheet}`, `lume/components/import/MapsCard.tsx` (Import screen), MCP `lume_build_maps_sheet` in `lume/lib/mcp/tools/internal.ts`.
- **How to test:** `cd lume && npx vitest run tests/maps tests/components/MapsCard.test.tsx tests/mcp`.
- **Good:** the scrape is only ever a `run_actor` pending action (Apify-capped at `ACTOR_RUN_CAP_USD`, paid add-ons off); nothing starts a run before Confirm, and MCP cannot file one (`run_actor` stays off `MCP_CREATABLE_KINDS`). Building the sheet reads a finished dataset (free) and creates one new lead list (step 1 · Imported), or nothing on a refusal.

### Lead lists: pipeline steps, Combine, Filter → Final (GTM-18)
- **Where:** `lume/lib/leads/steps.ts`, `lume/lib/leads/combine.ts`, `lume/lib/leads/finalFilter.ts`,
  `lume/lib/leads/lists/{store,stages}.ts`, `lume/app/api/lead-lists/combine`, `lume/app/api/lead-lists/[id]/final`,
  `lume/components/leads/{LeadsScreen,StageDialogs}.tsx`, `lume/components/shell/nav.ts`; migration `*_lume_pipeline_steps.sql`.
- **How to test:** `cd lume && npx vitest run tests/leads/sheetSteps.test.ts tests/api/leadListStages.test.ts tests/api/leadListStagesSafety.test.ts tests/shell/navSteps.test.ts tests/components/LeadsScreen.test.tsx`.
- **Good:** every row shows `# · Name` (1 Imported … 5 In campaign); Combine and Final save new
  lists and never edit or delete the sources (sources only move their step forward); a final
  sheet's excluded rows are never exported, sent to validation or counted in `email_count`;
  nothing is sent, pushed or paid. Sharing a list with a portal user (`sheet_set_ids`) waits for Conrad's yes.

### Influencer reactions and signals (GTM-10/14)
- **Where:** `lume/lib/influencers/`, `lume/lib/signal/`, `lume/app/api/influencers/*`,
  `lume/app/api/cron/signal-reactions`, `lume/app/api/cron/signal-alerts`, `lume/app/(app)/influencers/`;
  edge `supabase/functions/influencer-reactions/`, `influencer-lookup/`, `signal-comments/`, `_shared/influencer/`, `_shared/signal/`.
- **How to test:** `cd lume && npx vitest run tests/influencers tests/signal`;
  `cd supabase/functions && deno test --allow-env --allow-read _shared/influencer/ _shared/signal/ signal-comments/ influencer-reactions/ influencer-lookup/`.
- **Good:** the comments lane stays inside its caps ($10 Apify + $5 filter per
  cycle, $1 per PT day) and posts one #sales message when a cap hits; nothing is sent to leads.
  The reactions lane still files its Monday one-tap card.
  The contacts stage looks up the person's own work email with Blitz (`_shared/blitz.ts`, by their
  LinkedIn URL; records-guarded, no USD) and stores it in `signal_people.contacts`; the Slack card and
  reactor digest (`lume/lib/slack/signalCard.ts`) show `*Email:*` only when one was found. No key,
  no records, a miss or an outage → `contacts []`, card ships as before.

### Hiring Ops Signal (GTM-19)
- **Where:** `lume/lib/hiring/`, `lume/app/api/signals/hiring`, `lume/app/api/cron/hiring-signal`, `lume/app/(app)/signals/hiring/`.
- **How to test:** `cd lume && npx vitest run tests/hiring`.
- **Good:** bounded by `lume_settings.hiring_signal_config` (lanes, per-run
  caps, $40/month); plain ticks start runs only when `schedule` is exactly
  `true`; only writes sheet rows, never emails. The cron migration is not applied without Conrad's say-so.
  Contacts (`lume/lib/hiring/contact.ts`, `lume/lib/blitz.ts`, `tests/hiring/contact.test.ts`, `tests/blitz/`):
  only for rows that passed exclusions + dedupe + PM check; named person → work email (1 record),
  else one decision-maker via Waterfall ICP + email (≤3 records); `signal_hiring.contact_*`
  (`*_lume_hiring_contact.sql`); ≤36 records per tick; unset `BLITZ_API_KEY` = no lookup.

### LinkedIn draft generator (#content-gen)
- **Where:** `lume/lib/content/` (engine, rules, facts, slots, prompt, message, match, store, live, decide),
  `lume/lib/content/references/` (MIT copies of linkedin-skills references + LICENSE),
  `lume/app/api/cron/content-gen`, the `content_button` branch in `lume/lib/slack/payloads.ts` and
  `lume/app/api/slack/interactions/route.ts`, `lume/scripts/content-facts.ts`,
  `*_lume_content_gen.sql` (content_facts, content_drafts, content_spend, `content_config`), `*_lume_content_gen_cron.sql`.
- **How to test:** `cd lume && npx vitest run tests/content`.
- **Good:** Tue Proof / Wed Owner view / Thu Hand-raiser (breakdown and story weeks alternate); every number in a
  draft is in a fact it used; rule failures rewrite up to twice, then the draft is stored `rejected` and nothing is
  posted; a lead fact can't lead again within 21 days; every Claude call checked against the $5/month cap first and
  recorded in `content_spend`; `dry_run` (default true) means nothing reaches Slack; nothing ever posts to LinkedIn.
  Redo/Skip only touch `content_drafts`. Post matching reads `signal_posts`, never writes it.
  Tune-up (2026-11-27): no price or per-door figure in the body (first comment only); >1 PMS vendor name or >3 product
  functions rejected; tagline and "we built Kaspen" at most once per week (live drafts); no 8-word run shared with a draft
  from the last 14 days (closing paragraph and fact wording excepted); stats count unit/door counts (before/after pair
  once; times, years, 9-to-5 excluded); Proof prefers facts with a story (`content_facts.detail`, `*_lume_content_fact_detail.sql`,
  then cause-stating facts); superseded drafts don't block a lead fact.
  `content_drafts.attempt_log` (`*_lume_content_attempt_log.sql`) keeps why each failed try was rejected, on accepted drafts too.

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
- **How to test:** `cd lume && npx vitest run tests/operators tests/portal tests/slack tests/components/PortalLeadCard.test.tsx tests/components/PortalScreen.test.tsx`.
- **Call sheets (GTM-18):** the portal `sheet` tab reads `lume_portal_sheet_leads` scoped to the user's `sheet_set_ids` (empty = no tab, no rows).
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

### Signals inbox and the portal's signal accounts (90-day plan, phase 3)
- **Where:** `lume/app/(app)/signals/{page,hiring,influencers}`, `lume/app/api/signals/{inbox,accounts,accounts/deal}`,
  `lume/app/api/portal/signals`, `lume/lib/signals/{merge,events,store}.ts`, `lume/lib/portal/signals.ts`,
  `lume/components/signals/{SignalsInbox,SignalsNav,InfluencersList}.tsx`, `lume/components/portal/SignalsSection.tsx`;
  migration `*_lume_signal_accounts.sql` (one new table).
- **How to test:** `cd lume && npx vitest run tests/signals tests/portal/signals.test.ts tests/api/signalsRoutes.test.ts tests/components/SignalsInbox.test.tsx tests/today`;
  pgTAP `supabase/tests/lume_signal_accounts_test.sql`.
- **Good:** one row per company across `signal_hiring`, `signal_people` (+ `signal_posts`), `signal_reddit_mentions` and verified
  `influencer_reactors`, deduped by domain, else by normalized name (a name-only row joins the one domain that name belongs to);
  a Reddit author is its own account. Those four tables are only SELECTed; status and the three touches live in `signal_accounts`.
  A touch is a manual tick with its time: nothing is emailed, messaged or called. "Start deal" creates one deal under campaign
  `signals` in Conversation (owner's session only, idempotent) and changes no campaign or Instantly state.
  `/signals/hiring` still renders (the inbox filtered to hiring, then the Hiring Ops sheet); the influencers list is at `/signals/influencers`,
  and `/influencers` still lands on the candidate lists in `/import/leads` (the influencer-lookup alert links there).
  The dedupe is a set of rules, not a registry: known shared hosts, link shorteners and mailbox domains are not a company domain, legal forms
  are stripped only from the end of a name, known employer placeholders ("Self-employed") are not a company (a person with a placeholder and no
  site has no row), and saved state is never shared through a name two accounts carry. A host or placeholder the lists do not know can still
  merge two companies, so check `SHARED_HOSTS` and `NO_COMPANY` in `merge.ts` when a wrong merge shows up. Each account gets its own deal address.
  In the portal, signal accounts and the scoreboard go only to the signals client (`LUME_SIGNALS_CLIENT`, default Kaspen):
  any other client gets `{ enabled: false }` and no data.

### Today, Replies and the pilot stages (90-day plan, phase 2)
- **Where:** `lume/app/(app)/{today,replies}/`, `lume/app/api/{today,replies,scoreboard}`, `lume/lib/{today,replies,scoreboard}/`,
  `lume/lib/crm/{stages,pilot}.ts`, `lume/components/{today,replies}/`, `lume/components/crm/PilotLine.tsx`;
  migration `*_lume_pilot_stages.sql` (four `crm_stages` rows, four `crm_deals` columns, `lume_week_notes`).
- **How to test:** `cd lume && npx vitest run tests/crm tests/scoreboard tests/replies tests/today tests/api/crmRoutes.test.ts tests/api/scoreboardRoutes.test.ts tests/components/TodayReplies.test.tsx tests/components/CrmViews.test.tsx`;
  pgTAP `supabase/tests/lume_pilot_stages_test.sql`.
- **Good:** Conversation, Demo, Pilot, Paid sit after the eight original stages, which keep their names and positions; no existing deal moves.
  Moves onto the pilot line are by hand and direct; Won/Lost still file `crm_close_deal`; automation (`autoAdvance`) never moves a deal on to,
  along or off the pilot line. Check-ins fall due 10 and 25 days after `pilot_start_date` and only for deals in Pilot.
  The scoreboard week is Monday to Monday in America/Los_Angeles and counts a deal once per column.
  A waiting row is flagged past 60 minutes (exactly 60 is not). `/today` and `/replies` only read; the only writes are the
  owner's ticks on Lume's own rows (check-in, referral, task done, top objection). Nothing sends or spends.
  `/actions`, `/actions/<id>`, `/overview` and `/calendar` still render.

### Navigation: primary tabs, Volume, Admin (90-day regroup)
- **Where:** `lume/components/shell/{tabs,nav}.ts` (groups, step numbers, Alt keys),
  `TopBar.tsx` (desktop launcher), `MobileNav.tsx` (phone bar + More sheet), `CommandPalette.tsx` (⌘K).
- **How to test:** `cd lume && npx vitest run tests/shell tests/components/MobileNav.test.tsx tests/approvals/components.test.tsx tests/components/AgentChat.test.tsx`.
- **Good:** primary tabs are Today (`/today`), Signals (`/signals`), Pipeline (`/crm`), Replies (`/replies`), Agent in that order (desktop menu and phone bar);
  Volume holds Import 1, Leads 2–3, Progress 4, Rotate, Campaigns 5 and is collapsed unless you are on one of its pages;
  Admin holds Playground, Operator, Settings. No page is removed: every earlier URL still renders and has a ⌘K entry
  (`/calendar`, `/overview`, `/actions`, `/actions/<id>`, `/runs/...`; `/influencers` still redirects to `/import/leads`, and ⌘K has "Signals — Influencers").

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
- **Where:** `contact-email-finder/`, `email-validator/`, `operating-city-enricher/`, `instantly-push/`, `pipeline-watchdog/`, `_shared/{eta,backoff,pool,invoke,pacer,blitz}.ts`.
- **How to test:** `cd supabase/functions && deno test --allow-env --allow-read contact-email-finder/ email-validator/ operating-city-enricher/ instantly-push/ pipeline-watchdog/ _shared/`.
- **Finder routing:** rows with a person LinkedIn URL go to Blitz first (4 in flight, starts ≥250 ms
  apart, 429 retried); a miss, no key, exhausted records or an outage → connector-os, unchanged.
  `validation_result.found_by` is `blitz` or `connector-os`; found rows stay `pending` for the validator.
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
