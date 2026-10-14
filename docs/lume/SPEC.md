# Lume — Dashboard Spec

Oct 13, 2026 · @Conrad

## What Lume is

Lume is the single pane of glass over every outbound pipeline Conrad runs, with an orchestration agent that can trigger any stage from one place. Today the pieces exist but nothing sits above them: lead pulls run from Apify and Leadsfriday, validation happens through a Telegram bot, campaigns live in Instantly and a Gmail-API sender, replies land in Slack and Telegram, and status gets copied into Google Sheets by hand. Lume replaces the copying and the tab-switching, not the pipelines.

Three campaign families run through it from day one:

- **Kaspen** (kaspen.ai, the ZenPort product): property-management operators, email via Instantly plus the LinkedIn campaign run with Frank. Lead source is Apify scrapes of PM influencer audiences and Leadsfriday Apollo pulls.
- **Recruiter campaign** (the job search): GTM-engineer roles, sent from Conrad's own Gmail through the Gmail API with a reply bot; targets recruiters and hiring managers, not only founders.
- **Muse auto-apply**: company job boards, run by the Muse agent, feeding the same status sheet.

What already exists and Lume wraps rather than rebuilds: the Supabase schema with per-run campaign IDs, the enrichment pipeline (Apify crawler plus Claude Haiku for ICP and operating-city extraction), the Telegram validator bot with approval replies, the Instantly campaign and lead-list objects, the Gmail sender, the Leadsfriday scraper, the Google Sheet CRM with dropdown statuses, and the Linear "Spring 26" board. The one new thing is the orchestrator: an agent with tools over all of those, a voice and text surface on the dashboard, and the authority to run a stage end to end after Conrad confirms.

Goals, in order: (1) every manual review step is visible and confirmable from one screen, with a Telegram ping as the backup channel; (2) a new campaign is a flow-chart click, not a week of setup; (3) the dashboard itself is a proof asset for the GTM-engineer search, hosted on Vercel with Conrad's own commits.

## Design direction

Apple glass with a live-trading pulse: frosted panels floating over a slow dark mesh gradient, one accent colour, and a feed that visibly moves when a reply lands. The reference points are macOS Sequoia and iOS 26 Liquid Glass for materials, the pump.fun live page for the sense that something is always happening, and Linear for density and type. Not neon cyberpunk, not a SaaS template.

**Materials.** Glass is for elevated layers only: the top nav, the orchestrator panel, cards, modals, toasts. Reading surfaces (tables, the message thread) stay solid at 92 to 96 percent so text keeps AA contrast. Glass panels use backdrop blur 20 to 28 px, fill at 8 to 12 percent white on dark, a 1 px border at 12 percent white, and a soft inner highlight on the top edge. Corner radius 16 to 20 px on panels, 10 px on controls. No drop shadows heavier than 0.25 alpha.

**Backdrop.** A single full-bleed mesh gradient, dark navy to deep violet to near-black, drifting at roughly 60 seconds per cycle so the blur has something to refract. It never competes with content.

**Colour.** One accent: violet (around #8B5CF6) for the Lume orb, primary actions and live markers. Semantic only beyond that: green for replies and accepted, amber for pending approval, red for bounces and burned inboxes, cyan for opportunities. Everything else is white at 100, 70, 45 and 25 percent opacity.

**Type.** Inter or SF Pro for UI; JetBrains Mono for IDs, counts and anything that reads like a log. Dense but not cramped: 13 px body in tables, 15 px in cards, 11 px mono for metadata. Tabular numerals everywhere a number can change.

**Motion.** Numbers count up when they change. New feed items slide in from the top and settle. The orb breathes at rest, pulses when the agent is listening, and ripples outward when a reply arrives. Everything respects prefers-reduced-motion.

**The Lume orb.** The orchestrator is a presence, not a chat box in a corner. A glass sphere, roughly 120 px, sits in the top-right of every screen with a shader-driven refractive surface that reacts to audio input. Click or hold the spacebar to talk; it transcribes live, and its text replies appear as a glass sheet that slides out from under it. It can be dragged out into a larger panel for a full conversation. Its state (idle, listening, thinking, acting, needs approval) is readable from the orb alone.

**Layout.** Fixed glass top bar with the five surface tabs on the left and the orb on the right. Below it, a 12-column grid with 24 px gutters at desktop, collapsing to a single column on phone. The Overview screen is a bento grid; the working screens are table-first with a right rail for detail.

**Dark mode first.** Light mode is a nice-to-have and ships later.

## UI libraries

Build on shadcn/ui and layer a glass registry over it; take motion from Magic UI; build the orb in react-three-fiber. Avoid the all-in-one "liquid glass UI kits" for the app shell: they look great in a demo and fight you on tables, forms and accessibility.

| Layer | Pick | Why | Install |
| --- | --- | --- | --- |
| Base components | [shadcn/ui](https://ui.shadcn.com) on Next.js 15 + Tailwind 4 | Tables, dialogs, command palette, forms. The thing every other library here extends. Claude Code knows it cold. | `npx shadcn@latest init` |
| Glass styling | [glasscn](https://glasscn.vercel.app) (shadcn registry, 36 components) | Drop-in glass variants of shadcn components: Glass Card, Command, Combobox, Alert Dialog, Calendar. Same API as the originals, so a swap back is one import. | `npx shadcn add @glasscn/glass-card` |
| Glass styling, alternative | [shadcn-glass-ui](https://github.com/Yhooi2/shadcn-glass-ui-library) (59 components, Tailwind 4, OKLCH tokens) | More complete, with composite widgets and a stepper; marketed as AI-friendly. Pick this if glasscn is missing something you need. Do not use both. | `npx shadcn@latest add @shadcn-glass-ui/button-glass --deps` |
| Motion and feed effects | [Magic UI](https://magicui.design) | Number ticker, animated beam (for the pipeline flow view), border beam on live cards, shimmer on pending states, animated list for the reply feed. 150+ components, free, pairs with shadcn. | registry per component |
| Showpiece effects, sparingly | [Aceternity UI](https://ui.aceternity.com) | Background gradient animation for the mesh backdrop, spotlight on the orchestrator panel. Two or three components max; it leans dark and glowy and gets loud fast. | registry per component |
| Liquid glass hero elements | [liquid-glass-react](https://github.com/rdev/liquid-glass-react) | True refraction, chromatic aberration and elastic hover for the orb's sheet and the top nav only. Heavy; not for every card. | `npm i liquid-glass-react` |
| The orb | [react-three-fiber](https://docs.pmnd.rs/react-three-fiber) + drei + a custom GLSL shader | A refractive sphere (`MeshTransmissionMaterial` from drei is the shortcut) driven by audio amplitude via the Web Audio API. | `npm i three @react-three/fiber @react-three/drei` |
| Charts | [Recharts](https://recharts.org) via shadcn charts, or [Tremor](https://tremor.so) blocks | Area charts with gradient fills match the Instantly-style analytics screen. Recharts is lighter; Tremor gives you KPI cards for free. | `npx shadcn add chart` |
| Flow view | [React Flow](https://reactflow.dev) | The per-campaign pipeline diagram (import → validate → rotate → send → reply) as live nodes with status. Custom glass node component. | `npm i @xyflow/react` |
| Voice | Web Speech API for dictation; [Vapi](https://vapi.ai) or OpenAI Realtime if you want the orb to talk back | Start with Web Speech (free, zero setup, Chrome only). Upgrade later. | none |
| Icons | [Lucide](https://lucide.dev) | shadcn default; consistent stroke weight. | ships with shadcn |

Rules for whoever builds it:

- Glass is a Tailwind recipe, not a dependency. The baseline panel is `bg-white/8 backdrop-blur-2xl border border-white/12 rounded-2xl` with an inset top highlight; put it in one `glass` utility class and use the registry components only where they add behaviour.
- Every blurred panel has a solid fallback for browsers without `backdrop-filter` and for `prefers-reduced-transparency`.
- Nothing from the React Native glass libraries; this is web only.
- Framer Motion (now `motion`) is the only animation library. Magic UI and Aceternity already depend on it.

## Screens

Five surfaces in the top bar, in the order a lead moves through them, plus the orb on every screen.

**1. Overview (Live).** The home screen and the one that gets screenshotted. A bento grid: four KPI tiles across the top (sent today, replies today, pending approvals, open opportunities) with number tickers; a live reply feed on the left that streams in as webhooks fire, each item showing campaign chip, lead name, company, the first line of the reply, and a one-tap "open in Instantly / Gmail" link; a per-campaign strip on the right with sparkline, reply rate, and a health dot (green, amber for low acceptance, red for a burned inbox); a bottom row with inbox health (warmup status, bounce rate per sending account) and the next three scheduled runs with countdowns. Everything on this screen is read-only except the approval queue badge, which jumps to Validate.

**2. Import & Orders.** Where leads enter. Three source cards: Apify pull (pick an actor run or paste a dataset ID), Apollo link (paste the search URL; Lume hands it to the Leadsfriday scraper and polls for the result), and manual CSV upload. Below, an orders table: one row per pull with source, filters used, row count, enrichment status, and cost. Clicking a row opens the right rail with the raw sample, the enrichment config (Haiku ICP prompt, operating-city extraction on or off) and a "send to Validate" button. A pull can be scheduled from here, which creates the cron and shows it in the Overview countdown.

**3. Validate.** The approval queue that replaces the Telegram-only flow. A table of leads awaiting review, grouped by batch, with the auto-validator's verdict and reason (ICP match, missing email, duplicate against Supabase, flagged company). Keyboard-driven: J and K to move, A to approve, R to reject, E to edit a field in place. A batch header shows the 10 percent sample the validator pulled and lets Conrad approve the whole batch from the sample. Every approval here also posts to Telegram so the history stays in one place, and a Telegram reply still works as a fallback. Approved leads get their variables computed (first name, shortened company name, camel-cased fields) and move to the rotation hub.

**4. Lead Rotation Hub.** Assignment. Left column: the lead bank, filterable by ICP tag, geography, source and date. Centre: active campaigns as glass cards, each showing capacity (sends per day across its inboxes), queue depth, and a drop target. Drag a filtered set or a whole batch onto a campaign to assign. A rotation rule editor lets Conrad set rules that run on cron: "top up Kaspen email to 40 per day from the PM bank, newest first, skip any company already in an active sequence". Rules show their next run and last result. Right rail: the chosen campaign's sequence preview from Instantly or the Gmail template, so assignment and copy are checked together.

**5. Campaigns.** One row per campaign across all three families, with status, sends, acceptance, replies, interested, and a last-activity timestamp. Opening one gives a three-tab detail: Analytics (the Instantly-style stacked area chart over seven or thirty days, plus step-level drop-off), Flow (a React Flow diagram of this campaign's pipeline with live counts on each node and a "run this stage" button on nodes the agent can trigger), and Inbox (the reply thread list with an inline reply box that goes out through the right sender and lets Conrad hand a thread to the agent to draft). The Flow tab is the reusability piece: duplicate a campaign and it copies the whole flow with its rules.

**The orb panel.** Expanded, it is a conversation on the right third of the screen with three parts: the transcript, a "what I'm about to do" plan card for any multi-step action that needs a yes, and a tool activity log showing each call as it runs (pull 2,400 rows from Apify; dedupe against Supabase; 310 remain). Anything the agent does from here appears on the relevant screen at the same time.

## Functional spec

Lume is a Next.js app on Vercel with Supabase as the only database, a thin API layer of route handlers that wrap the existing scripts, and one orchestration agent built on the Claude API with tool use. Nothing moves to a new system; Lume reads and writes the tables the pipelines already use and adds a few of its own.

&#91;embedded content: Lume architecture · sources, API, agent, store, senders, notify\]

Sources feed in at the top, the agent calls the same API Conrad clicks, Supabase holds every order, event and rule, and the senders push out and report back by webhook. Notifications fan out from the events table, never from the senders directly.

**Data model.** Existing tables stay as they are. Lume adds the ones below; `campaign_run_id` is the join key everywhere, matching the per-run IDs already in Supabase.

| Table | Purpose | Key columns |
| --- | --- | --- |
| `orders` | One row per lead pull | source (apify, apollo\_link, csv), config json, row\_count, enrichment\_status, cost\_usd, created\_by (user or agent) |
| `validation_items` | The approval queue | lead\_id, batch\_id, verdict (auto\_pass, auto\_fail, needs\_review), reason, decided\_by, decided\_at, channel (dashboard, telegram) |
| `campaigns` | Unified view over Instantly, Gmail and Muse campaigns | family (kaspen, recruiter, muse), external\_id, sender\_type, status, capacity\_per\_day |
| `rotation_rules` | Cron-driven assignment rules | campaign\_id, filter json, daily\_cap, order\_by, cron, last\_run, last\_result |
| `events` | Append-only feed behind the Overview | type (sent, accepted, reply, bounce, approval, agent\_action), campaign\_run\_id, lead\_id, payload json, created\_at |
| `agent_runs` | Every orchestrator action | prompt, plan json, tool\_calls json, approval\_state, outcome |
| `scheduled_jobs` | The merged view of all crons | name, cron, target (rule, pull, campaign), next\_run, last\_status |

**Integrations.** Each one is a small adapter module exposing the same four verbs where they apply: `pull`, `push`, `status`, `webhook`.

| System | Lume reads | Lume writes | Transport |
| --- | --- | --- | --- |
| Supabase | everything | everything | supabase-js, RLS off for the service role, Realtime for the feed |
| Instantly | campaign analytics, lead status, replies, account vitals | add leads, pause/resume, reply | REST API + webhooks (reply, bounce, lead interested) |
| Gmail API | thread replies for the recruiter campaign | send, reply, label | OAuth on Conrad's account, Pub/Sub push for new mail |
| Telegram | approval replies | validation pings, agent approval requests, daily summary | Bot API, existing bot token |
| Apify | dataset items, run status | start actor runs | REST API |
| Leadsfriday | scrape results | submit Apollo search URL | their API, polled |
| Google Sheets | nothing after migration | mirror of campaign status for the job-search CRM, one-way | Sheets API |
| Slack | nothing | reply notifications to the Kaspen channel | incoming webhook |
| Linear | Spring 26 issues tagged lume | create an issue when a run fails | MCP or GraphQL |
| Muse | application status | enqueue companies to apply to | the custom MCP/CLI connector from the sketch |

**The orchestration agent.** One agent, model Claude Sonnet, system prompt describing the pipelines, with these tools: `list_orders`, `create_order`, `run_enrichment`, `get_validation_queue`, `decide_validation`, `list_campaigns`, `campaign_stats`, `assign_leads`, `create_rotation_rule`, `pause_campaign`, `resume_campaign`, `draft_reply`, `send_reply`, `schedule_job`, `notify`. Read tools run freely. Write tools fall into two tiers: low-risk (create an order, assign leads to a paused campaign, draft a reply) run and log; high-risk (send anything, approve a batch, activate a campaign, delete) stop and show a plan card that Conrad confirms on the dashboard or by replying `yes` to the Telegram ping. The agent never holds credentials; it calls Lume's own API with a short-lived token.

**Notification routing.** One `notify(event)` function and a routing table, editable from a settings sheet: Kaspen replies go to Slack and the feed; recruiter replies go to Telegram and the feed, and trigger the Muse status update; validation batches go to Telegram with a deep link into Validate; agent approvals go to Telegram and show on the orb; failed runs go to Telegram and open a Linear issue. Everything also writes an `events` row, so the feed is the complete record.

**Scheduled jobs.** The existing crons (weekly job-board append, enrichment runs, the abandoned briefing cron) get registered in `scheduled_jobs` and shown on the Overview with next-run countdowns. New ones are created from the dashboard. The runner is Vercel Cron for anything under a minute and a Railway worker for the long pulls, both reporting into the same table.

**Auth.** Single user for now: Supabase Auth with magic link, one allowed email. A read-only share link for the Overview, for recruiters and investors, is a Phase 3 item.

## Build plan

Manus owns the look; Claude Code owns everything that touches data. The handoff artefact between them is a Next.js repo with static screens and mock data that Claude Code then wires up.

**Manus produces:** a Next.js 15 + Tailwind 4 + shadcn project with the five screens and the orb panel built as components against a `mock/` data folder; the `glass` utility and design tokens in `globals.css`; the mesh backdrop; the orb as a react-three-fiber component with a stub audio input; Storybook or a `/design` route showing every component in every state (idle, loading, empty, error, pending approval); a `DESIGN.md` listing tokens, spacing and the motion rules. No API calls, no Supabase, no auth.

**Claude Code produces:** the Supabase migrations for the new tables; the adapter modules per integration, each wrapping the scripts that already exist in the Vertis Sync / NorthStar repo; route handlers and webhook endpoints; Supabase Realtime wiring for the feed; the orchestration agent with its tool definitions and the two-tier approval logic; Telegram deep links into Validate; the cron registry; deployment to Vercel with a Railway worker. It replaces `mock/` imports one screen at a time and keeps the design untouched.

**Repo layout.**

```
lume/
  app/            (overview, import, validate, rotate, campaigns, api/)
  components/     (ui/ from shadcn + glass, orb/, feed/, flow/)
  lib/
    adapters/     (instantly.ts, gmail.ts, telegram.ts, apify.ts, leadsfriday.ts, sheets.ts, slack.ts, linear.ts, muse.ts)
    agent/        (tools.ts, prompt.ts, approvals.ts)
    db/           (supabase.ts, types.ts)
  mock/           (Manus's fixtures, deleted screen by screen)
  supabase/migrations/
  worker/         (Railway long-running jobs)
  DESIGN.md
  CLAUDE.md       (the runbook, extended from the existing one)
```

**Phases.**

1. **Design in Manus** (this week): all five screens plus the orb, mock data, states. Review on the `/design` route, iterate on the Overview until it is screenshot-worthy.
2. **Overview + Validate live** (week 2): Supabase, events table, Instantly and Gmail webhooks into the feed, the validation queue replacing the Telegram-only flow with Telegram kept as backup. This alone removes most daily tab-switching.
3. **Import, Rotation, Campaigns live** (week 3): orders from Apify and Leadsfriday, rotation rules on cron, campaign detail with the flow view. Google Sheet mirror turned on.
4. **The orchestrator** (week 4): agent with read tools first, then low-risk writes, then high-risk writes with the plan card. Voice through Web Speech. Muse connector last.
5. **Polish and proof** (after): read-only share link, light mode, a 60-second screen recording for the GTM-engineer applications.

School stays priority one through the midterms next week, so phase 1 is the only thing that needs Conrad's time before then; Manus runs on its own.

## Manus prompt

Copy everything in the block. Attach the Instantly analytics screenshot and the LinkedIn inbox screenshot as references for density and the chart style.

```markdown
Build the front end of "Lume", a single-user GTM command center. Deliver a runnable Next.js 15 (App Router) + Tailwind 4 + TypeScript project with shadcn/ui as the component base, all screens working against local mock data. No backend, no auth, no API calls. I will wire the data layer separately, so keep every screen's data access behind one hook per screen (useOverviewData, useOrders, useValidationQueue, useRotation, useCampaigns) that currently reads from /mock/*.json.

AESTHETIC
Apple Liquid Glass meets a live trading terminal. Dark mode only. Frosted translucent panels float over a slow-drifting mesh gradient (deep navy → violet → near-black, ~60s cycle, subtle). Glass is only for elevated layers: the top bar, cards, the orchestrator panel, modals, toasts. Tables and reading surfaces are solid (92–96% opaque) for contrast. Panel recipe: bg-white/8, backdrop-blur-2xl, 1px border white/12, inset top highlight, rounded-2xl. Controls rounded-[10px]. No heavy shadows, no neon, no cyberpunk. Think macOS Sequoia + Linear density + the energy of a live feed that visibly moves.

One accent: violet #8B5CF6 for the orb, primary actions and live markers. Semantic colours only beyond that: green = replies/accepted, amber = pending approval, red = bounces/burned inbox, cyan = opportunities. Text is white at 100/70/45/25% opacity. Font: Inter for UI, JetBrains Mono for IDs, counts and log lines. Tabular numerals on anything that changes. Body 13px in tables, 15px in cards, 11px mono metadata.

Motion: numbers count up on change (Magic UI NumberTicker), new feed items slide in from the top (Magic UI AnimatedList), BorderBeam on live cards, shimmer on pending states. Mesh backdrop via Aceternity BackgroundGradientAnimation. Everything respects prefers-reduced-motion and has a solid fallback when backdrop-filter is unsupported.

LIBRARIES
shadcn/ui (init with the dark theme), glasscn registry for glass variants (npx shadcn add @glasscn/glass-card etc.), Magic UI for motion components, Aceternity only for the background gradient and a Spotlight on the orchestrator panel, Recharts via shadcn charts, @xyflow/react for the flow view, react-three-fiber + @react-three/drei for the orb, motion (Framer Motion) as the only animation lib, lucide-react icons. Put the glass recipe in one `.glass` utility in globals.css and use registry components only where they add behaviour.

LAYOUT
Fixed glass top bar: wordmark "lume" (lowercase, Inter 600) on the far left, then five tabs — Overview, Import, Validate, Rotate, Campaigns — and on the far right the Lume orb. Below: 12-column grid, 24px gutters, max-width 1440, collapsing to one column under 768px.

THE ORB
The orchestration agent is a presence, not a chat box. A ~120px glass sphere in the top-right of every screen, built with react-three-fiber using drei's MeshTransmissionMaterial, with a subtle refractive surface that reacts to an audio amplitude value (stub it with a sine wave; expose it as a prop). States, readable from the orb alone: idle (slow breathe), listening (pulse with the audio), thinking (slow internal swirl), acting (a ring orbiting it), needs-approval (amber ring, gentle bounce). Clicking it or holding spacebar opens a glass sheet that slides out beneath it with the live transcript. A drag handle expands it into a right-third panel with three parts: transcript, a "Plan" card listing the steps the agent wants to run with a Confirm / Cancel pair, and a tool activity log where each line is a mono entry like "pull 2,400 rows from Apify ✓ 3.1s".

SCREENS (mock data must look real: property-management company names, GTM-engineer job titles, realistic counts)

1. Overview — bento grid. Top row: four KPI tiles (Sent today, Replies today, Pending approvals, Open opportunities $) with NumberTicker and a 7-day sparkline each. Left two-thirds: a live reply feed, newest first, each item showing a campaign chip (Kaspen / Recruiter / Muse), lead name, company, first line of the reply, time, and a small "Open ↗" link; items animate in. Right third: a per-campaign strip — campaign name, reply rate, sparkline, and a health dot (green / amber / red) with a tooltip reason ("inbox warmup at 40%"). Bottom row: Inbox health (a table of sending accounts with warmup %, bounce rate, daily cap) and Next runs (three scheduled jobs with live countdowns).

2. Import — three source cards at the top: Apify pull (actor select + dataset ID input), Apollo link (paste a search URL, shows "sent to scraper, polling…" state), CSV upload (drop zone). Below: an Orders table — source, filters summary, rows, enrichment status (badge), cost, created by (person or "agent"). Row click opens a right rail with a 5-row raw sample, enrichment config (ICP prompt textarea, operating-city toggle) and a "Send to Validate" button. A "Schedule this pull" action opens a small cron modal.

3. Validate — the approval queue. Batch headers with batch name, count, source, the auto-validator's 10% sample result, and "Approve batch" / "Reject batch". Under each, a solid-surface table of leads: name, company, email, ICP tag, validator verdict (auto-pass / needs review / auto-fail) with a one-line reason, and inline-editable cells. Keyboard: J/K move, A approve, R reject, E edit; show a small keyboard-hints footer. Approving animates the row out. Include a toast "Also posted to Telegram".

4. Rotate — the lead rotation hub. Left column: the lead bank with filter chips (ICP, geography, source, date) and a count. Centre: active campaigns as glass cards showing capacity bar (sends/day across inboxes), queue depth, and a drop zone; dragging a filtered selection onto a card assigns it (use dnd-kit). Below the cards: a Rules table (name, target campaign, filter summary, daily cap, cron, next run, last result) with a "New rule" sheet that uses plain-language fields. Right rail: the selected campaign's sequence preview (step 1/2/3 with subject + body).

5. Campaigns — a table across all families: name, family chip, status, sent, accepted, replies, interested, last activity. Clicking opens a detail with three tabs. Analytics: the stacked area chart in the attached screenshot's style (Connections sent / Accepted / Messages / Replies / Opportunities as five series with gradient fills, 7d / 30d toggle, five stat cards above it). Flow: a React Flow diagram — nodes Import → Enrich → Validate → Rotate → Send → Reply, each a custom glass node with a live count and a status dot, and a "Run stage" button on nodes 1–4; a "Duplicate campaign" button in the header. Inbox: a two-pane thread list like a LinkedIn inbox (left: contacts with last message preview; right: the thread) with a reply box that has a "Draft with Lume" button.

STATES
Every screen needs loading (skeleton with shimmer), empty (one line + one action), and error states. Build a /design route that renders every component in every state, plus the colour, type and spacing tokens, so I can review the system in one place.

DELIVERABLES
The repo, runnable with npm run dev. A DESIGN.md with tokens, spacing scale, motion rules and the glass recipe. A /mock folder with one JSON per screen. Clean, typed components; no inline magic numbers; comments only where the intent isn't obvious. Make the Overview the screen you'd be proud to screenshot.
```
