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
- Edge: `cd supabase/functions && deno test _shared/`; `deno check telegram-inbox/index.ts`.
- DB: `supabase test db` (pgTAP in `supabase/tests/`).
