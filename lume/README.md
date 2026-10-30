# lume

Command center over the vertis-sync outbound pipelines. A second, independent
Next.js app inside this repo; see `docs/lume/2026-10-14-lume-design.md`
(design), `docs/lume/2026-10-14-lume.md` (plan) and `docs/lume/PR.md`.

Lume is a second door onto the existing pipelines, not a new pipeline: every
decision it makes goes through the same claim a Telegram tap uses, and every
spending or outbound step still waits on an explicit approval.

## Run locally

```sh
cd lume
npm install
cp .env.example .env.local   # fill in values (never commit them)
npm run dev                  # http://localhost:3000
```

No local Supabase is needed: the app talks to the hosted project
(`NEXT_PUBLIC_SUPABASE_URL`). Sign-in is a magic link to `LUME_ALLOWED_EMAIL`,
so `http://localhost:3000/auth/callback` must be on the Supabase Auth redirect
allowlist (see Owner setup). `/design` renders every component in each state
from fixtures (owner-gated like every page; no fetches).

Checks: `npm run lint`, `npx tsc --noEmit`, `npx vitest run`, `npm run build`.
`LUME_SMOKE=1 npm run smoke:db` is a read-only row count against the live DB.

## Secrets

Names only; values live in Vercel (Root Directory `lume`) and `.env.local`.
`lume/.env.example` lists every name the code reads.

| Name | Where | Used for |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Vercel | Browser + session client; Realtime |
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel | Server-only data layer and Storage (`raw-uploads`, `agent-projects`, `agent-chat-images`, `agent-chat-files`) |
| `LUME_ALLOWED_EMAIL` | Vercel | The one account allowed to sign in (middleware + magic-link route) |
| `LUME_ACTION_SECRET` | Vercel **and** edge secret | `X-Lume-Secret`: Lume → `telegram-inbox` decisions, and `telegram-inbox` → `/api/actions/<id>/execute` after a Telegram `lume_ok` |
| `LUME_HOOK_SECRET` | Vercel (+ vault `lume_hook_secret`, same value) | `X-Lume-Hook-Secret` on `/api/hooks/gate-opened` and `/api/cron/rotation-tick` (called by pg_net) |
| `LUME_INTERNAL_SECRET` | Vercel | `Authorization: Bearer` for the agent's tool calls into `/api/*`; also the HMAC key for CSV upload tickets |
| `LUME_URL` | Vercel **and** edge secret (+ vault `lume_url`) | Public base URL, no trailing slash: deep links in Telegram messages, magic-link origin, and where `telegram-inbox` calls execute. Unset = no deep links and approvals from Telegram execute nothing |
| `INSTANTLY_WEBHOOK_SECRET` | Vercel | `?secret=` on `/api/webhooks/instantly` |
| `INSTANTLY_API_KEY` | Vercel | Instantly reads and approved actions; unset = "Instantly not connected" |
| `ROTATE_CAMPAIGN_ID` | Vercel (optional) | The campaign the Rotate screen marks as `instantly-rotate`'s drain (same name + default as the edge function) |
| `ANTHROPIC_API_KEY` | Vercel | Orb agent (`/api/agent/run`) |
| `APIFY_API_TOKEN` | Vercel | Import → Apify pull |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Vercel (copies of the edge values) | Gate pings, approval prompts, ingest prompts; unset = Telegram no-ops with a warning |
| `LUME_SMOKE` | shell only | Opt-in for `npm run smoke:db` |

## Vault entries (Supabase, one-time, as project owner)

```sql
select vault.create_secret('https://<lume host>', 'lume_url');
select vault.create_secret('<same value as LUME_HOOK_SECRET>', 'lume_hook_secret');
select vault.create_secret('<owner email>', 'lume_owner_email');
```

`lume_url` + `lume_hook_secret`: `lume_gate_opened()` and
`lume_rotation_tick()` (pg_cron, every 15 min) return silently until both
exist. `lume_owner_email`: `lume_is_owner()` gates the RLS read policies on
`events` / `pending_actions` / `agent_runs` (Realtime); no secret = deny.

## Instantly webhook

Register in Instantly (all events):

```
https://<lume host>/api/webhooks/instantly?secret=<INSTANTLY_WEBHOOK_SECRET>
```

Bodies over 128 KB are refused; events are deduped on `webhook_id` and land in
`events` (Overview feed).

## Telegram deep links

Lume's messages carry links only when `LUME_URL` is set:

- gate ping: `${LUME_URL}/validate?gate=<kind>:<target_id>` (e.g.
  `/validate?gate=ingest_approval:7db3…`), focusing that gate card;
- approval prompt: `${LUME_URL}/actions/<pending_action_id>` (plan card with
  Confirm / Cancel), alongside the `lume_ok:<id>` / `lume_no:<id>` buttons.

## Owner setup

1. Supabase Auth → URL Configuration: add `http://localhost:3000/auth/callback`
   and `https://<lume host>/auth/callback` to the redirect allowlist.
2. Create the owner user (Authentication → Users → Add user, the
   `LUME_ALLOWED_EMAIL` address). The magic-link route never creates users.
3. Storage bucket `raw-uploads`: set `file_size_limit` to 20 MB and allow the
   Lume origin(s) in CORS; verify with a > 4.5 MB CSV from the deployed origin
   (the browser uploads straight to a signed URL).
4. Vercel: new project on this repo, **Root Directory `lume`**, env vars from
   the table above. Routes with `maxDuration = 300` (`/api/gates/decide`,
   `/api/actions/[id]/decide`, `/api/actions/[id]/execute`, `/api/agent/run`)
   need Fluid compute (Pro); on Hobby they are capped lower.
5. Edge secrets: `supabase secrets set LUME_ACTION_SECRET=… LUME_URL=…
   --project-ref rcfrumrbauwvyzfebxck` (then redeploy `telegram-inbox` via
   `deploy-functions.yml` if it was deployed before they existed).
6. Vault entries above; register the Instantly webhook.

## What Lume must never bypass

- **The tap.** Every stage still waits on an explicit approval. Gate decisions
  go through `telegram-inbox` (`X-Lume-Secret` entrypoint) and its conditional
  PATCH claims; Lume never writes pipeline state itself and never creates
  `validation_jobs`.
- **Pending actions.** Push to Instantly, campaign launch, replies, pauses and
  rule-proposed actions are `pending_actions` rows that execute only after
  Confirm in Lume or `lume_ok` in Telegram, exactly once (whichever claims
  first). `/api/gates/decide` refuses `push_go` / `camp_launch` / `lume_ok` /
  `lume_no` (`needs_confirmation`). The orb agent's high-risk tools only create
  pending actions.
- **Notify-only automation.** The rotation tick and the watchdog never act;
  they create pending actions / send pings.
- **Secrets** stay in env / vault, never in code or logs.

## Deploy

In the Vercel project settings, set **Root Directory** to `lume`. `vercel.json`
here declares the framework; `crons` stays empty (the rotation tick is
pg_cron → `/api/cron/rotation-tick`, not a Vercel cron).

Environment variable names are listed in `.env.example`.

## Auth (one account)

- Magic link only. `POST /api/auth/magic-link` checks the email against
  `LUME_ALLOWED_EMAIL` and calls Supabase only for the owner, with
  `shouldCreateUser: false`. Every caller gets `{ ok: true }`, so the endpoint
  cannot be used to discover the owner's address.
- **The owner's auth user must already exist.** One-time setup: create the user
  in the Supabase dashboard (Authentication → Users → Add user, the allowed
  email), or run a single sign-in with `shouldCreateUser: true` once and switch
  it back.
- Supabase Auth → URL Configuration must allowlist `<origin>/auth/callback` for
  `http://localhost:3000` and the Vercel URL before the link can land.
- Middleware: pages redirect to `/login` (no session) or `/forbidden` (wrong
  account); `/api/*` gets `401` / `403` JSON instead. `lib/auth/publicPaths.ts`
  is the single list of what passes without a session.
- Server-to-server: `/api/*` also accepts `Authorization: Bearer
  ${LUME_INTERNAL_SECRET}` (the agent's tool wrappers, Task 14). The middleware
  compares it in constant time with Web Crypto (`lib/auth/bearer.ts`,
  Edge-safe): valid → through, present-but-wrong → 401, absent → cookie
  session. The route's `requireOwner(req)` repeats the check as defence in
  depth and also 401s a wrong bearer without falling back to cookies.
- **Route-guard rule:** every `app/api/**/route.ts` must call `requireOwner`
  or `requireSecret` from `@/lib/auth/guards` itself; the middleware is the
  second line, not the first. `tests/api/routeGuards.test.ts` enforces it, with
  an explicit allowlist for routes that are their own gate (`/api/auth/magic-link`).
  `requireSecret(req, { query: 'secret' }, ENV)` reads the secret from a URL
  parameter for callers that cannot set headers (Instantly webhooks).
- `requestOrigin()` prefers `LUME_URL` over forwarded headers, so a magic link
  requested from a Vercel preview deployment redirects to the production
  origin after login (the one Supabase Auth allowlists). Set `LUME_URL` per
  environment if a preview should stay on itself.

## Data layer

- `lib/db/service.ts` (server-only) wraps the service-role client: `lume_gates`
  / `lume_orders` / `lume_lead_bank` views, `lume_overview()` /
  `lume_scheduled_jobs()` RPCs, `events` writes. Row types are hand-written in
  `lib/db/types.ts`; pure query/message/action logic lives in sibling files
  (`leadBankQuery.ts`, `telegram.messages.ts`, `pipeline.actions.ts`) so it is
  unit-tested without `server-only`.
- Gate decisions go through `lib/adapters/pipeline.ts` → the `telegram-inbox`
  entrypoint; Lume never copies the conditional-PATCH claims.
- `lib/adapters/telegram.ts` no-ops with a `[telegram] not configured` warning
  when `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` are unset.
- Screens use SWR hooks in `hooks/` that revalidate on Realtime inserts
  (`useRealtimeInvalidate`).
- Instantly (`lib/adapters/instantly.ts`, server-only; pure mappers in
  `instantly.map.ts`): 60 s in-memory cache per URL. With `INSTANTLY_API_KEY`
  unset every `/api/instantly/*` route answers `200 {configured:false}` and
  the Overview tiles show "Instantly not connected".
- Overview: `/api/overview` is database-only and refetches on Realtime
  inserts it shows (filtered, ≤ 1 per 5 s); `/api/overview/instantly` is a
  60 s poll. The adapter shares in-flight requests, negative-caches failures
  15 s (or a 429's `Retry-After`) and runs ≤ 4 per-campaign calls at once.
  "Today" is the owner's zone (`lib/time/owner.ts`, America/Los_Angeles).
- `/api/webhooks/instantly?secret=…` (128 KB cap, counted in bytes) → `events` via `logEvent` (dedupe on
  `webhook_id` = `instantly:<event_type>:<id>[:<timestamp>]` or a SHA-256 of the body).
- Validate (`/validate`): decisions go through `POST /api/gates/decide`
  (`maxDuration = 300`; 409 = already handled, 202 = still working, re-read).
  `push_go` / `camp_launch` / `lume_ok` / `lume_no` are refused there (400
  `needs_confirmation`): "Push these" creates a `pending_actions` row via
  `POST /api/actions` (`lib/actions/create.ts`, one awaiting action per kind
  per job). Campaign pick, barriers and names mode are Lume-local conditional
  PATCHes on `/api/gates/campaign/[jobId]` (GET = `instantly-push` preview).
  Per-lead rows: `/api/jobs/[id]/rows`; edits only while the job waits at the
  finder prompt (`finder_status='awaiting_decision'`, validator not started)
  and only on `pending` rows. The push confirmation payload snapshots the
  campaign, barriers, names mode and eligible count; barriers are locked
  while it awaits. Hotkeys A/R never fire Confirm/Cancel or spending actions.
  Pure logic in `lib/validate/*`.
- Import (`/import`): `POST /api/import/{apify,csv,apollo-link}` only create
  the intake. CSV uploads skip the function body (Vercel ~4.5 MB cap):
  `/api/import/csv/sign` returns a signed Storage upload URL for
  `lume/<uuid>.csv` plus an `upload_ticket` (`<exp>.<HMAC(path|exp)>`, 15 min); the browser uploads with
  `uploadToSignedUrl`, then `/api/import/csv` verifies path + ticket, refuses
  a path already ingested (409), stats/streams the object (≤ 20 MB) and calls
  `createIngestForStoredObject` (`maxDuration = 90`). A verified upload
  rejected as too large / not CSV / empty, or whose ingest insert fails, is
  removed from Storage. Apify reads items with a 40 MB cap under one
  105 s deadline (504 `apify_timeout`). Otherwise the intake — `lib/import/ingest.ts` uploads to `raw-uploads/lume/<uuid>.csv`,
  inserts `telegram_ingests` (`sender_platform='lume'`, `awaiting_approval`)
  and sends telegram-inbox's own prompt/keyboard; Apollo links become
  `apollo_orders` `awaiting_count` with the `lfo_*` keyboard. Approval and
  everything after stay in telegram-inbox; Lume never creates
  `validation_jobs`. Email-column detection is a copy of telegram-inbox's
  (`lib/import/csv.ts`; `tests/import/parity.test.ts` compares the source). CSV writer flattens newlines (the
  pipeline parses line by line). The rail's count picker sends
  `lfo_count:<id>:<n>` via `/api/gates/decide` (click only).
- Live read check: `LUME_SMOKE=1 npm run smoke:db` (row counts only).
- Agent chat images (paste ⌘V, drop, or the paperclip; png / jpeg / gif / webp,
  ≤ 5 per message, image-only messages allowed). **Vercel body cap:** functions
  refuse request bodies over ~4.5 MB, and 5 images inline would not fit, so the
  run never carries image bytes. The browser shrinks each image
  (`lib/agent/imageClient.ts`: long edge ≤ 1568 px, re-encoded to ≤ ~1.5 MB)
  and uploads it alone to `POST /api/agent/images` (raw body, ≤ 2 MB,
  `requireOwner`), which sniffs the magic bytes (the client's type is never
  trusted), parses the PNG / JPEG / GIF / WebP header and refuses an
  unreadable one or one over 8000 px on a side (422; the API would 400 every
  run that replays it), and stores it in the private `agent-chat-images` bucket
  (service role only: no Storage policies; bucket limit 2 MB and the four
  image types) at `<uuid>.<ext>`. `/api/agent/run` then gets only
  `images: [{ path, name }]`, reads each object back, re-sniffs it, and sends it
  to Claude as a base64 `image` block before the text; the user message stores
  `{ path, name, media_type }` in `agent_messages.attachments` (no base64 in
  rows). Later runs replay the images of the newest 3 owner turns that have
  any, among the turns the char budget keeps (≤ 5 images,
  `selectReplayImages`), within 18 MB raw per run together with the current
  ones (`fitImageBudget`, oldest dropped first); the rest become
  "[image omitted: <name>]". If the API still 400s on an image before any
  output, the run retries once with every replayed image as a note; if the
  current message's own image is refused, the error says so. A paste that
  carries text (Excel, Numbers, Word add a picture of the cells) pastes the
  text only; Safari's empty `files` falls back to `items`. Bubbles show images through
  `GET /api/agent/images/<path>` (owner session, `private` cache, `nosniff`),
  never a signed URL. An image removed from the composer before sending stays
  in the bucket (orphan, harmless; no cleanup job yet).
- Agent chat spreadsheets (.xlsx / .csv: paperclip, drop, or paste a copied
  file; ≤ 3 per message beside the 5 images, ≤ 10 MB each; `.xls` and
  password-protected workbooks are refused with "save as .xlsx"). **Upload
  path:** 10 MB is over Vercel's ~4.5 MB body cap, so the bytes never pass
  through a function: `POST /api/agent/files/sign` checks the name and size
  and returns a one-time signed Storage upload URL for `<uuid>.<xlsx|csv>` in
  the private `agent-chat-files` bucket (service role only, no Storage
  policies; 20 MB limit; MIME allowlist xlsx / text/csv / gzip) plus an
  `upload_ticket` (HMAC, purpose `agent-chat-file-upload`, 15 min); the
  browser uploads with `uploadToSignedUrl` (raw ArrayBuffer, so the
  Content-Type is ours); `POST /api/agent/files` then reads the object back
  and **validates it after upload, before any use**: magic bytes decide the
  type (zip with `xl/workbook.xml` → xlsx, text → CSV; OLE / other binary →
  415), never the name. Parsing (`lib/sheets/`): exceljs 4.4.0 (MIT; its
  `uuid` is overridden to 11.1.1 for GHSA-w5hq-g745-h8pq) behind an fflate
  streaming zip-bomb guard that inflates and counts before exceljs runs
  (≤ 50 MB uncompressed, ≤ 20 sheets, ≤ 500k cells; cell text capped at
  50M chars so shared strings cannot fan out); header row detected (title
  rows skipped), formulas → cached values, dates → ISO, merged-overflow and
  empty columns dropped, hidden sheets noted. CSV: UTF-8 (BOM or not),
  UTF-16 by BOM, else latin1; delimiter `, ; tab |` detected. The parsed
  tables go to `<uuid>.json.gz`, an `agent_chat_files` row holds the
  per-sheet counts and the summary; a refused upload is deleted.
  `/api/agent/run` takes `files: [{ id }]`; each file's summary (sheets with
  counts, header, first 50 rows as CSV, ≤ 20k chars, cuts named) is its own
  text block in an `<attachment>` tag marked as data; the message stores
  `{ kind: 'file', id, name, file_kind, size_bytes, sheets }` in
  `attachments` beside the image refs (chips on reload). Replay: summaries
  of the newest 3 owner turns with files (≤ 3 files); older ones become
  `[file: <name> — use read_attachment(file_id: …)]`; the char budget
  charges a file as its note, like images. Tools: `read_attachment` (read;
  `GET /api/agent/files/<id>/rows`, ≤ 500 rows / 20k chars per page, only
  files attached in that chat), `load_attachment_as_leads` (low; a sheet →
  lead review set with the column mapping shown and overridable, every
  column kept in raw, same `normaliseLead`; `lead_review_sets.source_kind
  'attachment'`), `stage_attachment_for_validation` (high, always asks:
  pending kind `stage_attachment`; the build refuses a sheet with no single
  email column, the executor re-checks rows and email column, then
  `createIngest` — the Import CSV intake, which stops at the ingest gate;
  telegram-inbox creates the validation job after the owner approves).
  Import card: `.xlsx` goes through the same upload + parse, asks which
  sheet when several have rows, then `POST /api/import/xlsx` puts that
  sheet into the CSV intake. Project files accept `.xlsx` (each sheet
  extracted as CSV for `read_project_file`). An attachment removed before
  sending stays in the bucket (orphan, harmless; no cleanup job yet).

## PM influencer reactions → Apollo CSV (built-in skill)

The agent always knows this skill (static prompt section in `lib/agent/prompt.ts`;
`list_skills` and the Skills menu show it as built-in, `lib/agent/builtinSkills.ts`).
Pipeline: edge function `influencer-reactions` (port of
`~/Downloads/pm-reactions-pipeline`); tables `influencers` (26 seeded with the
2026-10-08 run's yield and cost), `influencer_runs`, `influencer_apify_runs`,
`influencer_posts`, `influencer_reactors` (the old run's 7,638 reactors imported
with their triage / verify verdicts, so a re-run pays Perplexity only for new
reactors), `influencer_exports`.

- Tools: `list_influencers`, `estimate_influencer_run`, `get_influencer_run` (read);
  `export_influencer_csv`, `add_influencer`, `update_influencer`,
  `cancel_influencer_run` (low); `start_influencer_run` → `influencer_run` and
  `approve_reactions` → `influencer_reactions` (high, always ask, never skippable).
- Approval 1 runs posts + Haiku top-10 ranking, then the run stops at
  `awaiting_approval` with the exact reactions bill. Approval 2 runs reactions,
  triage, Perplexity verify (capped by `max_verify_usd`, default $10) and the
  door retry. Both executors re-check live state before calling the function.
- Every Apify start is gated by `lume_influencer_reserve_apify` on the same
  monthly cap as company research (`LUME_RESEARCH_APIFY_CAP_USD`, default 29).
- Leaks are swept by `lume_influencer_sweep` on every invocation and every
  5 minutes (pg_cron `influencer-sweep` → the function's `sweep` action, which
  also aborts the Apify runs it closes): dead chains (30 min), never-started
  (5 min) or hung (30 min) Apify rows, rows under a finished run, runs older
  than 6 h, reactions bills unapproved for 72 h.
- Output: `GET /api/influencers/exports/<id>` CSV (First Name, Last Name, Title,
  Company, Website = domain, Person Linkedin Url, City, State, Country, optional
  Door Count / Reacted To). Owner: import into an Apollo list, open it as a
  people search, paste the URL to Lume → `create_order`. Lume never calls Apollo.
- Edge secrets used: `APIFY_API_TOKEN`, `ANTHROPIC_API_KEY`, `PERPLEXITY_API_KEY`,
  optional `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`, `LUME_URL`.

## Design system notes

- shadcn CLI 4 `base-nova` preset = **Base UI primitives**, not Radix. Compose
  with the `render` prop (`<Button render={<Link href=… />}>`); there is no
  `asChild`.
- Tokens: `accent` is the translucent hover/selected tint. The solid brand
  violet is `brand` (alias) or `violet`; `primary` is the same violet for
  buttons. Text is `fg`, `fg-70`, `fg-46`, `fg-24`.
- `.glass` for elevated panels, `.surface` for tables. `GlassCard` is
  hand-written (the glasscn registry was unreachable) and composes with
  shadcn's `CardHeader` / `CardContent`.
- Shimmer bars use `.anim-shimmer`, never `.shimmer` (shadcn owns that name for
  a text-clip effect).
- **Reduced motion rule for new components:** `<MotionConfig reducedMotion="user">`
  wraps the app, so `motion` components snap instead of animating. Purely
  decorative infinite motion (BorderBeam, orb breathe, feed slide-in) must
  render nothing or stand still under `useReducedMotion()` / the
  `prefers-reduced-motion` media query. Use the `.anim-*` classes for CSS
  animation so the global rule in `globals.css` can switch them off. Re-adding
  `border-beam` from the Magic UI registry will overwrite its gate; re-apply it.

## Develop

```sh
npm install
npm run dev        # http://localhost:3000
npm run lint
npm test           # vitest
npm run build
```
