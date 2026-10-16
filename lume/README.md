# lume

Command center over the vertis-sync outbound pipelines. A second, independent
Next.js app inside this repo; see `docs/lume/2026-10-14-lume-design.md`.

## Deploy

In the Vercel project settings, set **Root Directory** to `lume`. `vercel.json`
here declares the framework; `crons` is filled by later tasks.

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
- Live read check: `LUME_SMOKE=1 npm run smoke:db` (row counts only).

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

Full README lands in Task 15.
