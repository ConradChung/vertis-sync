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

**Phase 3 — replies:** `list_replies` (read; `id`→`reply_to_uuid`, `eaccount`, subject, body, lead, thread), `label_reply` (low; Instantly interest status + CRM stage; unsubscribe → blocklist).

**Phase 4 — costs + orders:** `get_costs` (read; Leadsfriday = count × $0.003 exact, fractional credits; balances via API or last `apollo_orders.new_balance`; finder/validator prices from a `lume_prices` settings table), `edit_order` (low; only while `count_status` is pre-order; re-count shown with exact cost).

**Phase 5 — reporting + cleanup:** `reply_rates` (read; group by country/title/campaign joined to lead-bank attributes), `edit_rule` (high, skippable), `cancel_order` (high, skippable; only before spend).

Open API questions for phases 2–5 are listed in the design doc; resolve them before detailing those tasks.
