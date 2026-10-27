# Lume agent capabilities — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (or executing-plans) to implement this plan task-by-task.

**Goal:** Approve / Deny high-risk agent actions inside the chat, a per-chat "skip permissions" mode, then the ten new agent capabilities from `docs/lume/2026-10-26-agent-capabilities-design.md`.

**Architecture:** High-tier tools keep creating `pending_actions` rows (one audit trail; Telegram + `/actions/<id>` keep working). The chat card decides the row through the existing `POST /api/actions/[id]/decide`; afterwards the client sends an automatic follow-up turn so the agent continues with the outcome. Skip mode is a run-body flag: `requestApproval` creates the row, then claims + executes it server-side (`decided_via='agent'`) unless the kind is in `ALWAYS_ASK_KINDS`.

**Tech stack:** Next.js (app router) in `lume/`, Anthropic SDK tool runner, Supabase (service client, pgTAP via MCP `execute_sql`), Vitest, zod.

**Conventions (read before starting):**
- Work on branch `lume` in `~/vertis-sync`. App code is under `lume/`; run commands from `lume/` (`npx vitest run <path>`, `npx tsc --noEmit -p .`, `npx next build`).
- Migrations: no Docker. Apply with Supabase MCP `apply_migration` FIRST, then save the file as `supabase/migrations/<ledger version>_<name>.sql` using `select version from supabase_migrations.schema_migrations order by version desc limit 1`.
- pgTAP: run inside `begin; … rollback;` via `execute_sql`, collecting assertions in one query (execute_sql returns only the last statement).
- Commit footer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Match surrounding code: comment density, naming, `cn()`, glass tokens, `text-[13px]` scale.

---

## Phase 1 — In-chat approvals + skip permissions

### Task 1: Migration — `decided_via='agent'` + `agent_messages.auto`

**Files:**
- Create: `supabase/migrations/<ver>_lume_agent_skip.sql`
- Modify: `supabase/tests/lume_core_test.sql` (add assertions + bump plan count)

**Step 1: Write the pgTAP assertions** (append to `lume_core_test.sql`):
```sql
select lives_ok($$ update pending_actions set decided_via = 'agent' where false $$, 'decided_via accepts agent');
select throws_ok($$ insert into pending_actions (kind, payload, requested_by, decided_via) values ('pause_campaign', '{}'::jsonb, 'agent', 'bogus') $$, '23514', null, 'decided_via still rejects unknown values');
select has_column('agent_messages', 'auto', 'agent_messages.auto exists');
select col_default_is('agent_messages', 'auto', 'false', 'auto defaults false');
```
**Step 2: Run them via `execute_sql` → expect the `agent`/`auto` assertions to FAIL.**

**Step 3: Migration**
```sql
-- Skip-permissions mode approves on the owner's behalf; record it distinctly.
alter table pending_actions drop constraint if exists pending_actions_decided_via_check;
alter table pending_actions add constraint pending_actions_decided_via_check
  check (decided_via in ('lume','telegram','agent'));

-- Automatic follow-up turns (approval outcomes) render as a compact line, not a user bubble.
alter table agent_messages add column if not exists auto boolean not null default false;
```
Check the real constraint name first: `select conname from pg_constraint where conrelid = 'pending_actions'::regclass and contype = 'c';`

**Step 4: Apply via MCP, rename file to ledger version, re-run pgTAP → PASS.**

**Step 5: Commit** `feat(lume): decided_via agent + agent_messages.auto`

### Task 2: `ALWAYS_ASK_KINDS` in permissions

**Files:** Modify `lume/lib/agent/permissions.ts`; Test `lume/lib/agent/permissions.test.ts` (create if absent).

**Step 1: Failing test**
```ts
import { describe, expect, it } from 'vitest'
import { HIGH_RISK_KIND, skippable } from '@/lib/agent/permissions'

describe('skippable', () => {
  it('always asks for spending and emailing kinds', () => {
    for (const k of ['run_actor', 'send_reply', 'decide_gate', 'launch_campaign', 'resume_campaign'] as const) expect(skippable(k)).toBe(false)
  })
  it('skips everything else', () => {
    for (const k of ['assign_leads', 'activate_rule', 'pause_campaign', 'create_campaign', 'delete_rule', 'update_sequence'] as const) expect(skippable(k)).toBe(true)
  })
  it('covers every agent high-risk kind', () => {
    for (const k of Object.values(HIGH_RISK_KIND)) expect(typeof skippable(k)).toBe('boolean')
  })
})
```
**Step 2:** `npx vitest run lib/agent/permissions.test.ts` → FAIL (`skippable` not exported).

**Step 3: Implement**
```ts
/**
 * Kinds that still need a tap in skip-permissions mode: they spend money
 * (Apify runs; gate decisions that buy Leadsfriday / finder / validator work)
 * or email leads (a reply; launching or resuming a campaign starts sends).
 */
export const ALWAYS_ASK_KINDS: ReadonlySet<PendingKind> = new Set([
  'run_actor', 'send_reply', 'decide_gate', 'launch_campaign', 'resume_campaign',
])

export const skippable = (kind: PendingKind): boolean => !ALWAYS_ASK_KINDS.has(kind)
```
**Step 4:** test → PASS. **Step 5: Commit** `feat(lume): always-ask kinds for skip mode`

> Owner note: `launch_campaign` / `resume_campaign` are always-ask because they start emailing leads. `assign_leads` is skippable (owner chose that explicitly).

### Task 3: `claimDecision` records who decided

**Files:** Modify `lume/lib/actions/store.ts:29-45`; Test `lume/lib/actions/store.test.ts` (existing mock pattern — follow it).

**Step 1: Failing test:** `claimDecision(id, true, 'agent')` sends `decided_via: 'agent'` in the update; default call still sends `'lume'`.

**Step 3: Implement** — signature `claimDecision(id: string, approve: boolean, via: 'lume' | 'agent' = 'lume')`, use `decided_via: via`. Update `PendingActionRow.decided_via` type in `lib/db/types.ts` to include `'agent'`.

**Step 4:** PASS; existing decide-route tests still PASS. **Step 5: Commit.**

### Task 4: Skip mode in `requestApproval`

**Files:** Modify `lume/lib/agent/tools.ts` (`ToolDeps`, `requestApproval`); Test `lume/lib/agent/tools.test.ts`.

**Step 1: Failing tests**
```ts
it('skip mode executes skippable kinds and reports the outcome', async () => {
  const autoApprove = vi.fn(async () => ({ status: 'executed' as const, result: { ok: true }, error: null }))
  const tools = buildTools({ ...baseDeps, skipPermissions: true, autoApprove })
  const out = await find(tools, 'pause_campaign').run({ campaign_id: 'c1' })
  expect(autoApprove).toHaveBeenCalledWith('action-1')
  expect(out).toMatchObject({ status: 'auto_approved', action_id: 'action-1', outcome: 'executed' })
})
it('skip mode still asks for always-ask kinds', async () => {
  const autoApprove = vi.fn()
  const tools = buildTools({ ...baseDeps, skipPermissions: true, autoApprove })
  const out = await find(tools, 'send_reply').run(validReplyInput)
  expect(autoApprove).not.toHaveBeenCalled()
  expect(out.status).toBe('awaiting_approval')
})
it('without skip mode nothing auto-runs', async () => { /* skipPermissions false → awaiting_approval */ })
it('a duplicate awaiting action is never auto-approved', async () => { /* createAction throws DuplicateActionError → awaiting_approval, autoApprove not called */ })
```
(Reuse the file's existing `baseDeps` / `find` helpers; add them if absent.)

**Step 3: Implement**
```ts
// ToolDeps
  /** Skip-permissions mode for this run: skippable kinds are approved + executed at once. */
  skipPermissions?: boolean
  /** Claims (decided_via 'agent') and executes a pending action. Server-side only. */
  autoApprove?: (actionId: string) => Promise<{ status: 'executed' | 'failed' | 'not_claimable'; result: Record<string, Json> | null; error: string | null }>
```
In `requestApproval`, after `createAction` succeeds:
```ts
    if (deps.skipPermissions && deps.autoApprove && skippable(built.kind)) {
      const done = await deps.autoApprove(action.id)
      return {
        status: 'auto_approved',
        action_id: action.id,
        deep_link: `/actions/${action.id}`,
        summary: built.payload.summary,
        outcome: done.status,
        result: done.result,
        ...(done.error ? { error: done.error } : {}),
      }
    }
```
Update the high-tier description suffix: "…returns awaiting_approval, or auto_approved with the outcome when the owner has skip permissions on for this chat."

**Step 4:** PASS. **Step 5: Commit.**

### Task 5: Run route — `skip_permissions` + `auto_approved` events

**Files:** Modify `lume/app/api/agent/run/route.ts`, `lume/lib/agent/history.ts` (`StoredApproval`), `lume/lib/agent/conversations.ts` (insert `auto`); Test `lume/app/api/agent/run/route.test.ts` (existing).

- `Body`: add `skip_permissions: z.boolean().optional()` and `auto: z.boolean().optional()` (marks a client follow-up turn; stored on the user message).
- `buildTools` deps: `skipPermissions: body.data.skip_permissions === true`, `autoApprove: async (id) => { const c = await claimDecision(id, true, 'agent'); if (!c) return { status: 'not_claimable', result: null, error: null }; const o = await executeAction(id); return o.ran ? { status: o.status, result: o.result, error: o.error } : { status: 'not_claimable', result: null, error: null } }`.
- `StoredApproval` gains `state?: 'awaiting' | 'auto_executed' | 'auto_failed'`.
- `hooks.onEnd`: on `result.status === 'auto_approved'` send `{ type: 'approval', …, state: result.outcome === 'executed' ? 'auto_executed' : 'auto_failed' }` and do NOT set `needs_approval`.
- Telegram: skip-mode rows still get the `createAction` ping; after auto-execution call `editMessage(row.telegram_message_id, '⚡ Auto-approved (skip mode) — <kind>')` best effort (reuse the decide route's pattern).

Tests: body with `skip_permissions: true` passes the flag to deps (mock `buildTools`); an `auto_approved` tool result emits an approval event with `state` and the run ends `done`, not `needs_approval`; `auto: true` is stored on the user message.

**Commit** `feat(lume): skip-permissions runs`

### Task 6: Live approval state on load

**Files:** Modify `lume/app/api/agent/conversations/[id]/route.ts`; Test alongside.

When returning messages, collect every `approvals[].action_id`, read `pending_actions (id, status)` in one `in` query, and attach `status` to each approval. The card then shows Approved / Denied / Executed / Failed / Expired after a reload or a Telegram tap. Test: an approval whose row is `executed` comes back with `status: 'executed'`; missing rows → `status: null`.

### Task 7: `ApprovalCard` (replaces `PlanCard` in the chat)

**Files:** Create `lume/components/agent/ApprovalCard.tsx`; Modify `components/agent/AgentChat.tsx:603` (`<PlanCard … />` → `<ApprovalCard … />`); Test `components/agent/ApprovalCard.test.tsx` (Testing Library, existing setup).

Behaviour per approval:
- `state: 'auto_executed'` → compact line `⚡ Ran without asking (skip mode): <summary>` + link to `/actions/<id>`.
- `state: 'auto_failed'` → same, red, "failed".
- awaiting → summary, **Approve** (primary) + **Deny** (outline) + small "Details" link to deep_link. Click → `POST /api/actions/<id>/decide { decision }`; buttons disabled while in flight; 409 `already_handled` → show the returned status ("Already approved in Telegram").
- After a decision resolves, call `onDecided({ action_id, tool, summary, decision, status, error })`.
- Settled (`status` from Task 6 or after click) → no buttons, status chip.

Tests: renders buttons when awaiting; approve posts `{decision:'approve'}` and calls `onDecided` with the response status; 409 shows already-handled text and still calls `onDecided`; auto states render no buttons. Keep `PlanCard` for the orb overlay (unchanged).

### Task 8: Automatic follow-up turn

**Files:** Modify `lume/hooks/useAgentChat.ts` (`send(text, skill?, opts?: { auto?: boolean })`, `ChatMessage.auto`, request body `auto`, `skip_permissions`), `components/agent/AgentChat.tsx` (render `auto` user messages as a one-line muted row instead of a bubble).

`onDecided` → `chat.send(followUp, undefined, { auto: true })` where
```ts
const followUp = d.decision === 'approve'
  ? `[approval] I approved ${d.tool} (${d.summary}). Outcome: ${d.status}${d.error ? ` — ${d.error}` : ''}. Continue.`
  : `[approval] I denied ${d.tool} (${d.summary}). Don't retry it; tell me what you'd do instead.`
```
If a run is busy, queue it and send when `busy` turns false (one pending follow-up per action id). Tests in `hooks/useAgentChat.test.ts`: `auto` reaches the request body; queued follow-up fires after the live run settles.

### Task 9: Skip-permissions toggle + banner

**Files:** Modify `components/agent/AgentChat.tsx`, `hooks/useAgentChat.ts`.

- Toolbar: a switch "Skip permissions" (lucide `ShieldOff`), `aria-pressed`.
- On: red banner above the composer: "Skip permissions is on — I'll act without asking, except spending money or emailing leads." with "Turn off".
- State is per conversation in memory; `newChat()` and switching conversations reset it to off. Never persisted.
- `send` includes `skip_permissions` when on.

Test: toggle sends the flag; new chat clears it.

### Task 10: System prompt

**Files:** Modify `lume/lib/agent/prompt.ts`; snapshot/contains test if one exists.

Add: high-risk tools now return `awaiting_approval` (owner decides in the chat card — say so briefly and stop; don't ask them to open a link) or `auto_approved` with `outcome` (report what happened). Messages starting `[approval]` are the owner's decision outcome; continue from them.

### Task 11: Verify + deploy

- `npx vitest run` (all), `npx tsc --noEmit -p .`, `npx next build` — all green.
- Manual on prod after `npx vercel --prod --yes`: ask the agent to pause a test campaign → card → Deny → follow-up turn; again → Approve → executes, Telegram message edited; toggle skip → pause runs without a card; `send_reply` still shows a card.
- Code review (requesting-code-review) before moving to Phase 2.

---

## Phases 2–5 (detailed after Phase 1 ships and API research lands)

Each tool follows the existing pattern: read/low tools call a new Lume `/api/*` route with the internal bearer; the route calls an adapter in `lume/lib/adapters/`; high tools add a `PendingActionKind`, a `buildActionRequest` case, an executor handler, and a pgTAP check-constraint update.

**Phase 2 — cycling + cap:** `list_campaign_leads` (read), `contact_usage` (read), `remove_leads` (high, kind `remove_leads`, skippable; snapshot each lead into a `lume_cycled_leads` table before deleting; never removes replied/interested), cycle-out rule kind (daily, `after_days`, `refill_to`; created inactive, activation via approval) in `instantly-rotate` / rules schema.

Phase 2 built 2026-10-27 (branch `lume`): adapter `lib/adapters/instantlyLeads.ts` (+ `.map.ts`), routes `GET /api/campaigns/[id]/leads`, `GET /api/instantly/usage`; `remove_leads` builder/executor `lib/actions/removeLeads.ts`; cycle-out in `lib/rules/cycle.ts` + `lib/rules/tick.ts`; tool `create_cycle_out_rule` (low). Migrations `20261027092720_lume_remove_leads`, `20261027092727_lume_cycle_out_rules`, `20261027092906_lume_cycle_out_rules_fixes`. Decisions: "finished N days ago" = `timestamp_last_contact` (Instantly has no completion timestamp); interested = `lt_interest_status > 0`; the tick stays notify-only (a due cycle-out rule files a `remove_leads` with `rule_id`; the executor files the refill as `assign_leads`); `refill_to` = target total leads in the campaign (Instantly `leads_count` before the delete − removed + lead_bank queued); CRM deals untouched, lead_bank rows archived like the rotator does; agent removals by state allow only finished_no_reply / bounced / no_reply_after_days.

**Phase 3 — replies:** `list_replies` (read; `id`→`reply_to_uuid`, `eaccount`, subject, body, lead, thread), `label_reply` (low; Instantly interest status + CRM stage; unsubscribe → blocklist).

**Phase 4 — costs + orders:** `get_costs` (read; Leadsfriday = count × $0.003 exact, fractional credits; balances via API or last `apollo_orders.new_balance`; finder/validator prices from a `lume_prices` settings table), `edit_order` (low; only while `count_status` is pre-order; re-count shown with exact cost).

**Phase 5 — reporting + cleanup:** `reply_rates` (read; group by country/title/campaign joined to lead-bank attributes), `edit_rule` (high, skippable), `cancel_order` (high, skippable; only before spend).

Open API questions for phases 2–5 are listed in the design doc; resolve them before detailing those tasks.

---

## Phase G — Grok Bot operator layer (build after Phase 1 deploys, before Phase 2)

Goal: moving from Telegram to Grok Bot is flipping settings, not a project. See the design doc
section "Grok Bot operator layer". Default behaviour after this phase is unchanged (Telegram stays on).

### G1: Verticals + operator keys (migration + store)
- Tables: `lume_verticals (id uuid pk, name text unique, campaign_ids text[] default '{}', scopes text[] default '{}' check subset of {campaign,orders,replies,validation}, is_default bool default false, created_at, archived_at)`; `lume_operators (id uuid pk, vertical_id fk, label text, key_hash text unique (sha256 hex), created_at, revoked_at, last_seen_at)`. RLS on, service role only (match existing lume_* tables). At most one `is_default` vertical (partial unique index) — it receives items no vertical claims.
- `pending_actions.decided_via` check adds `'operator'`; add `pending_actions.decided_by_operator uuid null references lume_operators`. `agent_conversations.vertical_id uuid null`.
- pgTAP: constraints, default uniqueness, decided_via operator.
- `lume/lib/operators/store.ts`: create vertical, list, update, archive; `createOperatorKey(verticalId, label)` → returns the raw key once (32 random bytes base64url) and stores sha256; `findOperatorByKey(raw)` (constant-time compare on hash); `revoke`; `touch(operatorId)`.

### G2: Operator sign-in + attribution
- `GET /auth/operator?k=<key>`: on a valid, unrevoked key → same Supabase owner session as `/auth/key` (full owner rights, owner's decision) PLUS an httpOnly, secure, sameSite=lax cookie `lume_op=<operator id>.<hmac>` signed with `LUME_INTERNAL_SECRET`; redirect to `/operator`. Invalid → `/login?error=exchange_failed`. `Referrer-Policy: no-referrer`.
- `lib/operators/session.ts`: `currentOperator(req)` verifies the cookie HMAC, loads the operator (null if revoked → also clear cookie).
- Revocation signs the bot out: each `/auth/operator` sign-in records its Supabase session id (JWT `session_id`) in `lume_operator_sessions` (fails closed if it cannot); `revokeOperator` calls `lume_revoke_operator_sessions(op)` (security definer, service_role only) to delete those `auth.sessions` rows. The middleware signs out locally (→ /login, or 401 for the API) any request whose `lume_op` names a revoked or deleted operator.
- Attribution: `/api/actions/[id]/decide` → `claimDecision(id, approve, op ? 'operator' : 'lume')` + `decided_by_operator`; agent run route creates conversations with the operator's `vertical_id` and passes the operator/vertical into the prompt context ("You are being operated by the <name> Grok Bot; its campaigns: …"). Owner sign-in clears `lume_op`.
- Header shows a small "Operator: <vertical>" chip when signed in as an operator.

### G3: Routing items to verticals
- `lib/operators/route.ts` pure `verticalFor(item, verticals)`: pending action / gate / alert → vertical whose `campaign_ids` contains its campaign id; else by scope, but only when exactly one live (non-archived) vertical holds that scope (a shared scope is ambiguous); else the default vertical; else null (owner only). Unit-tested.
- "Needs confirmation" = awaiting `pending_actions` + open pipeline gates (`lume_gates` view) routed to the vertical, money/validation kinds first.

### G4: Alert feed + channel switch
- Table `lume_alerts (id, source text, severity info|warn|urgent, title, body, link, campaign_id, scope, created_at, acked_at, acked_by_operator)`; Realtime enabled like `events`.
- Edge shared helper `supabase/functions/_shared/alert.ts`: `alert({source, severity, title, body, link?, campaign_id?, scope?, telegram?: () => Promise<void>})` — always inserts into `lume_alerts`; runs the function's existing Telegram send only when env `ALERT_CHANNELS` includes `telegram` (default `telegram,feed`). Gate prompts with buttons keep their Telegram path behind the same switch; the feed row links to the Lume page that decides the gate.
- Swap each function's direct Telegram send for `alert(...)` keeping the exact Telegram text/buttons inside the `telegram` callback: hnwi-pipeline-orchestrator, contact-email-finder, jobsearch-notify, email-validator, jobsearch-puller, operating-city-enricher, instantly-push, pipeline-watchdog, jobsearch-sheet-writer, leadsfriday-order, slack-inbox, telegram-inbox (outbound notices only). Lume side: lib/adapters/telegram.ts `sendMessage` callers (actions/execute.ts, rules/tick.ts, import/ingest.ts, agent run route) go through `lib/alerts.ts` with the same switch (`ALERT_CHANNELS` env on Vercel).
- Deploy every edited function; deno tests for the helper (channel parsing, telegram skipped when off, feed insert always). Verify by hash after deploy, as in earlier phases.

### G5: `/operator` check-in page
- Server-rendered, plain semantic HTML (headings, lists, tables, real `<button>`/`<form>`), minimal JS, so a browsing agent reads it reliably; no animations. Sections in order: **Needs confirmation** (routed approvals + gates; Approve/Deny inline via decide route / gate decide route; money items show exact cost: Leadsfriday count × $0.003), **Alerts** (unacked, with Acknowledge + "Acknowledge all"), **Recent outcomes** (last 24h actions/events for the vertical), **Campaigns** (sent / replies / bounces today + 7d for its campaigns), **Inputs** (Apollo link → existing apollo-link import; CSV upload → existing import; "Message Lume's agent" → opens /agent in a vertical-tagged conversation). A machine-readable `<pre id="operator-summary">` JSON block at the top with counts (needs_confirmation, unacked_alerts, last_checked_at) for quick routine checks.
- Visiting the page calls `touch(operator)`. Owner can open `/operator?vertical=<id>` too.

### G6: Settings + hub
- `/settings/verticals` (owner only — not operators? owner decided full rights, so operators may view; creating/revoking keys requires owner session WITHOUT lume_op cookie): create/edit/archive verticals, generate a key (shown once with copy button + the full sign-in URL), revoke.
- Hub: Overview gets a "Verticals" strip — per vertical: last check-in (relative, red if > 30 min), needs-confirmation count, unacked alerts, last action by its bot.

### G7: Grok setup guide
- `docs/lume/GROK-SETUP.md`: per-bot instructions template (role, vertical, sign-in link placeholder, confirmation rules template with example spend thresholds, never-do list), routine prompt ("every 15 minutes open <link>/operator; read #operator-summary; handle Needs confirmation per rules; acknowledge alerts after reporting urgent ones to me"), first-run test checklist, cutover steps (set `ALERT_CHANNELS=feed` on Vercel + Supabase secrets, watch for 3 days, then Telegram retirement).

### G8: Verify + deploy
Full vitest, tsc, next build, deno tests; apply migrations; deploy functions + Vercel; manual: create a test vertical, mint key, sign in via link in a private window → lands on /operator, decide a test pending action → `decided_via=operator`; `ALERT_CHANNELS` default keeps Telegram identical.

### G9: Seed verticals + master bot (owner decision 2026-10-26)
- Seed verticals (migration data or a one-off script, idempotent by name): **Job search / GTM roles** (scopes orders, validation, campaign), **PM reactions** (campaign, validation), **HNWI / wealth management** (validation, campaign), **Kaspen / Zenport** (orders, validation, campaign), **Roofers** (campaign). Map `campaign_ids` from `lume_campaigns` / Instantly campaign names where the match is unambiguous; leave the rest empty and list them in the report for the owner. **Kaspen / Zenport** is the default vertical.
- **Master operator:** `lume_operators.vertical_id` nullable + `is_master bool default false` (check: master ⇔ vertical_id is null). Master sees every vertical on `/operator` (grouped) and is the fallback for unrouted items instead of the default vertical when one exists.
- Agent tools so the master bot can build new verticals by chatting with Lume's agent (research → pipeline → vertical): `list_verticals` (read), `create_vertical` (low; name, scopes, campaign_ids — created with no key), `update_vertical` (low; rename, campaigns, scopes, archive), `issue_operator_key` (high, skippable; returns the sign-in link once in the tool result/card, never stored in chat history in plaintext — store only a masked form in agent_messages). System prompt: when asked to stand up a new vertical, research the market (web tools, Apify store), propose the pipeline (actor → filter → validation → campaign/sequence) as a diagram, create it step by step with existing tools, then create_vertical and offer issue_operator_key.
- GROK-SETUP.md gets a "Master bot" section: its instructions, the "new vertical" playbook, and how it hands a new key to a fresh Grok Bot.
