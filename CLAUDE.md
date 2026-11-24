# vertis-sync

Outbound lead pipelines on one Supabase project (`rcfrumrbauwvyzfebxck`),
driven from Telegram, with two Next.js front ends.

## Repo map

- `/` (root `app/`, `components/`, `lib/`, `middleware.ts`) — **NorthStar CRM**,
  the original Next.js app (validation dashboard, Apify/HNWI starts).
  `.env.example` at the root also lists every edge-function secret name.
- `lume/` — **Lume**, a second, independent Next.js app (own `package.json`,
  Vercel Root Directory `lume`): command center over the same pipelines.
  Start with `lume/README.md`.
- `supabase/migrations/` — schema history (Lume's are `*_lume_*.sql`).
- `supabase/functions/` — Deno edge functions; `telegram-inbox` is the
  decision entrypoint for every gate; shared code in `_shared/`
  (`_shared/lume/` for Lume's action parsing / secret compare).
- `supabase/tests/` — pgTAP (`supabase test db`).
- `docs/lume/` — Lume spec, design, plan, inventory, PR description (`PR.md`).
- `docs/plans/` — design + plan docs for the Telegram CSV approval, Apify
  validate and job-search pipelines; `docs/instantly-rotation.md`.

## Non-negotiables

- **Every stage waits on a tap.** No pipeline step that spends money or sends
  anything advances without an explicit owner decision (Telegram button, or
  Lume's equivalent).
  **One exception, the GTM-14 comments lane only** (`signal-comments`, owner
  approval 2026-11-22): polling Frank's posts/comments and the filter spend it
  triggers (Haiku, Perplexity, door counts) run under a standing approval,
  capped at $10 Apify + $5 filter per Apify billing cycle and $1 per PT day
  across the lane. Any cap stops the lane and posts one #sales message; 80% of
  either cycle cap posts one warning. Nothing is sent to leads (cards hand over
  text to copy). The reactions lane still files its Monday one-tap card. No
  other pipeline may cite this exception.
- **Exception: scheduled signal lanes.** The Hiring Ops Signal (GTM-19,
  `lume/lib/hiring/`) starts capped Apify runs, company checks and Haiku
  drafts on a schedule without a per-run tap, as the owner approved
  (2026-11-23). It is bounded by `lume_settings.hiring_signal_config`
  (lanes on/off, per-run caps, $40/month total) and only writes rows to the
  Hiring Ops Signal sheet; emails are sent by hand. The schedule
  (`*_lume_hiring_signal_cron.sql`) is applied only after the owner says so.
- **Lume decides through `telegram-inbox`**, via its `X-Lume-Secret`
  entrypoint (`LUME_ACTION_SECRET`), so Telegram and Lume race for the same
  conditional-PATCH claim. Lume never writes pipeline state directly and
  never creates `validation_jobs`.
- **Nothing auto-pushes.** Instantly pushes, campaign launches, replies and
  pauses are `pending_actions` that execute once, after Confirm in Lume or
  `lume_ok` in Telegram. The orb agent can only propose them.
- **Watchdog and rotation tick are notify-only**: they ping / create pending
  actions, never act.
- **Secrets never in code**, logs or docs: env (Vercel / `.env.local`),
  `supabase secrets set`, or Supabase vault (`lume_url`, `lume_hook_secret`,
  `lume_owner_email`). `.env.example` files hold names only.
- **Deploy edge functions from disk** through `.github/workflows/deploy-functions.yml`
  (runs on push to `main` touching `supabase/functions/**`), never by
  pasting code into the dashboard or MCP. `telegram-inbox` / `slack-inbox` /
  `hnwi-pipeline-orchestrator` deploy with `--no-verify-jwt`.
- **Migrations:** apply via the Supabase MCP (`apply_migration`), then name
  the file after the version the ledger recorded (`list_migrations`), so
  disk and ledger match. Never edit an applied migration; add a `_fixes` one.
- Changes to existing edge functions must be additive (Lume touched only
  `telegram-inbox`; see `docs/lume/PR.md`).

## Checks

- Root: `npx tsc --noEmit`, `npm run lint`.
- Lume: `cd lume && npm run lint && npx tsc --noEmit && npx vitest run && npm run build`.
- Edge: `cd supabase/functions && deno test _shared/ email-validator/`; send-body tests (env read at import): `deno test --allow-env slack-inbox/ telegram-inbox/ leadsfriday-order/`; `deno check telegram-inbox/index.ts`.
- DB: `supabase test db` (pgTAP in `supabase/tests/`).

## Verification (before you say "done")

A Stop hook (`.claude/hooks/require-checks.sh`, registered in
`.claude/settings.json`) won't let a session end with unverified changes.

1. Before starting a change, delete `review/verdict.txt`.
2. When the change is finished, write `review/summary.md` (what you changed
   and what you'll tell Conrad), then run the `verify-app` subagent and pass it
   that summary. It runs on Fable, reads the diff and `feature-map.md`, runs
   `.claude/hooks/require-checks.sh --checks-only`, and writes PASS or FAIL
   with next instructions to `review/verdict.txt`. It never edits code.
3. On FAIL, do what its instructions say, delete the verdict, and run it again.
   The hook blocks the stop until the checks pass and the verdict is PASS and
   newer than your last edit; after 3 failed rounds it lets you stop, and you
   must tell Conrad plainly what isn't verified.
4. Anything Conrad has had to say twice becomes a hard check in the
   "hard checks" block of `require-checks.sh`, not a note here.
5. When a feature is added or its tests move, update `feature-map.md`.

The hook only checks what changed since the merge base with main, so a
session that changed nothing stops freely. Headless `claude --bare -p` runs
skip project hooks; a headless loop must run the review step itself.
