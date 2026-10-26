import { z } from 'zod'
import type { Json, PendingActionKind } from '@/lib/db/types'
import { HIGH_RISK_KIND, TOOL_TIERS, type ToolName, type ToolTier } from '@/lib/agent/permissions'

/**
 * The orb agent's tools. Each one is declared once with `tiered(spec, tier)`:
 *
 *  - read / low: `run` calls one of Lume's own `/api/*` routes with
 *    `Authorization: Bearer ${LUME_INTERNAL_SECRET}` (the same guard the UI
 *    passes through), or drafts / notifies. Never Supabase or Instantly.
 *  - high: the spec carries only a `payload` builder. `tiered` gives it a
 *    `run` that calls `createAction(kind, payload, 'agent', { agentRunId })`
 *    and returns `{ status: 'awaiting_approval', action_id, deep_link }`. There
 *    is no code path from a high-risk tool to a route or an adapter.
 *
 * Pure (deps injected) so the tiering is unit-tested without a network.
 * `toRunnableTools` in `lib/agent/runnable.ts` adapts these for the SDK runner.
 */

export type ToolResult = Record<string, unknown>

export interface CreatedAction {
  id: string
}

export interface ToolDeps {
  fetch: (url: string, init: RequestInit & { headers: Record<string, string> }) => Promise<Response>
  createAction: (
    kind: PendingActionKind,
    payload: Record<string, Json>,
    requestedBy: 'agent',
    meta: { agentRunId: string }
  ) => Promise<CreatedAction>
  agentRunId: string
  /** Lume's own origin. Defaults to `LUME_URL`. */
  baseUrl?: string
  /** Defaults to `LUME_INTERNAL_SECRET`. */
  secret?: string
  /** Telegram message to the owner (the `notify` tool). */
  notify?: (text: string) => Promise<{ ok: boolean; error?: string }>
}

export interface AgentTool {
  name: ToolName
  tier: ToolTier
  description: string
  inputSchema: z.ZodType
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: (input: any) => Promise<ToolResult>
}

type RouteCall = (path: string, init?: { method?: 'GET' | 'POST'; body?: unknown }) => Promise<unknown>

interface RunSpec<S extends z.ZodType> {
  name: ToolName
  description: string
  inputSchema: S
  run: (input: z.infer<S>, ctx: { call: RouteCall; deps: ToolDeps }) => Promise<ToolResult>
}

interface HighSpec<S extends z.ZodType> {
  name: ToolName
  description: string
  inputSchema: S
  /** What the owner confirms. Must include a human `summary`. */
  payload: (input: z.infer<S>) => Record<string, Json> & { summary: string }
}

type Built = (deps: ToolDeps, call: RouteCall) => AgentTool

/**
 * Declare a tool at a tier. The tier must match `TOOL_TIERS` (checked when
 * the module loads). A `high` tool must be a payload spec; a read/low tool
 * must be a run spec.
 */
export function tiered<S extends z.ZodType>(spec: RunSpec<S>, tier: 'read' | 'low'): Built
export function tiered<S extends z.ZodType>(spec: HighSpec<S>, tier: 'high'): Built
export function tiered<S extends z.ZodType>(spec: RunSpec<S> | HighSpec<S>, tier: ToolTier): Built {
  if (TOOL_TIERS[spec.name] !== tier) {
    throw new Error(`tool ${spec.name} declared ${tier} but TOOL_TIERS says ${TOOL_TIERS[spec.name]}`)
  }
  if (tier === 'high') {
    if (!('payload' in spec)) throw new Error(`high-risk tool ${spec.name} needs a payload builder`)
    const kind = HIGH_RISK_KIND[spec.name]
    if (!kind) throw new Error(`high-risk tool ${spec.name} has no pending_actions kind`)
    return (deps) => ({
      name: spec.name,
      tier,
      description: `${spec.description} Needs the owner's approval: this only creates a pending action and returns awaiting_approval; it does not run.`,
      inputSchema: spec.inputSchema,
      run: async (input) => requestApproval(deps, kind, spec.payload(input)),
    })
  }
  if (!('run' in spec)) throw new Error(`tool ${spec.name} needs a run function`)
  return (deps, call) => ({
    name: spec.name,
    tier,
    description: spec.description,
    inputSchema: spec.inputSchema,
    run: (input) => spec.run(input, { call, deps }),
  })
}

async function requestApproval(
  deps: ToolDeps,
  kind: PendingActionKind,
  payload: Record<string, Json>
): Promise<ToolResult> {
  try {
    const action = await deps.createAction(kind, payload, 'agent', { agentRunId: deps.agentRunId })
    return {
      status: 'awaiting_approval',
      action_id: action.id,
      deep_link: `/actions/${action.id}`,
      summary: payload.summary,
    }
  } catch (err) {
    // Same action already waiting for this job: point at it rather than fail.
    if (err instanceof Error && err.name === 'DuplicateActionError') {
      const existingId = (err as Error & { existingId?: string }).existingId ?? ''
      return {
        status: 'awaiting_approval',
        action_id: existingId,
        deep_link: existingId ? `/actions/${existingId}` : null,
        note: 'An identical action was already awaiting approval; no new one was created.',
      }
    }
    throw err
  }
}

function routeCaller(deps: ToolDeps): RouteCall {
  const base = (deps.baseUrl ?? process.env.LUME_URL ?? 'http://localhost:3000').replace(/\/+$/, '')
  const secret = deps.secret ?? process.env.LUME_INTERNAL_SECRET ?? ''
  return async (path, init = {}) => {
    const method = init.method ?? 'GET'
    const headers: Record<string, string> = { Authorization: `Bearer ${secret}`, Accept: 'application/json' }
    if (init.body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await deps.fetch(`${base}${path}`, {
      method,
      headers,
      cache: 'no-store',
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    })
    const text = await res.text()
    let data: unknown = text
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      // non-JSON body: keep the text
    }
    if (!res.ok) {
      const detail = typeof data === 'object' && data && 'error' in data ? String((data as { error: unknown }).error) : text.slice(0, 200)
      throw new Error(`${method} ${path} failed: HTTP ${res.status} ${detail}`)
    }
    return data
  }
}

// ---------------------------------------------------------------------------
// Schemas

const uuid = z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, 'uuid')
const id = z.string().min(1).max(200)
const summary = z.string().min(1).max(500).optional().describe('One line the owner reads before approving.')
const leadFilter = z
  .object({
    source: z.string().max(100).optional().describe("'lead_bank' or 'validation_rows'"),
    icp_status: z.string().max(100).optional(),
    city: z.string().max(200).optional().describe('case-insensitive contains match'),
    since: z.string().max(40).optional().describe('ISO date lower bound on created_at'),
  })
  .describe('Lead bank filter')

/** Gate buttons that must go through their own confirmation flow, never decide_validation. */
const BLOCKED_GATE_ACTIONS = new Set(['push_go', 'camp_launch', 'lume_ok', 'lume_no'])

const json = (v: unknown) => (v === undefined ? null : (v as Json))

// ---------------------------------------------------------------------------
// The tools

const SPECS: Built[] = [
  // read ---------------------------------------------------------------------
  tiered(
    {
      name: 'list_orders',
      description: 'List recent lead orders (CSV ingests, Apollo link orders, dashboard jobs, job batches), newest first, with status and counts.',
      inputSchema: z.object({ limit: z.number().int().min(1).max(200).optional() }),
      run: async ({ limit }, { call }) => ({ orders: await call(`/api/orders?limit=${limit ?? 50}`) }),
    },
    'read'
  ),
  tiered(
    {
      name: 'get_validation_queue',
      description: 'The open validation gates (decisions waiting on the owner), each with its kind, target id and the gate buttons (callback_data) it accepts.',
      inputSchema: z.object({}),
      run: async (_i, { call }) => ({ gates: await call('/api/gates') }),
    },
    'read'
  ),
  tiered(
    {
      name: 'list_campaigns',
      description: 'All campaigns Lume tracks (Instantly and others) with status and headline numbers.',
      inputSchema: z.object({}),
      run: async (_i, { call }) => ({ campaigns: await call('/api/campaigns') }),
    },
    'read'
  ),
  tiered(
    {
      name: 'campaign_stats',
      description: 'Daily and per-step analytics for one campaign (sends, opens, replies, bounces).',
      inputSchema: z.object({ campaign_id: id }),
      run: async ({ campaign_id }, { call }) => ({
        stats: await call(`/api/campaigns/${encodeURIComponent(campaign_id)}/analytics`),
      }),
    },
    'read'
  ),
  tiered(
    {
      name: 'list_rules',
      description: 'Rotation rules (lead bank to campaign on a cron), active or not, with next and last run.',
      inputSchema: z.object({}),
      run: async (_i, { call }) => ({ rules: await call('/api/rules') }),
    },
    'read'
  ),
  tiered(
    {
      name: 'list_scheduled_jobs',
      description: 'Every scheduled job (pg_cron and rotation rules) with its next run time.',
      inputSchema: z.object({}),
      run: async (_i, { call }) => ({ jobs: await call('/api/scheduled-jobs') }),
    },
    'read'
  ),
  tiered(
    {
      name: 'inbox_health',
      description: 'Instantly sending accounts: status, warmup status/score, daily limit.',
      inputSchema: z.object({}),
      run: async (_i, { call }) => ({ inboxes: await call('/api/instantly/accounts') }),
    },
    'read'
  ),

  // low ----------------------------------------------------------------------
  tiered(
    {
      name: 'create_order',
      description:
        'Start a lead pull from an Apollo people-search URL. Creates an order awaiting a lead-count choice; nothing is spent until the owner picks a count in Telegram or Lume.',
      inputSchema: z.object({ apollo_url: z.string().url().max(4096) }),
      run: async ({ apollo_url }, { call }) => ({
        created: await call('/api/import/apollo-link', { method: 'POST', body: { url: apollo_url } }),
      }),
    },
    'low'
  ),
  tiered(
    {
      name: 'draft_reply',
      description:
        'Record a draft reply to a lead for the owner to read. Does not send anything; sending is send_reply, which needs approval.',
      inputSchema: z.object({
        draft: z.string().min(1).max(5000),
        campaign_id: id.optional(),
        reply_to_uuid: id.optional().describe('Instantly email id being replied to'),
      }),
      run: async ({ draft, campaign_id, reply_to_uuid }) => ({
        status: 'draft_only',
        draft,
        campaign_id: campaign_id ?? null,
        reply_to_uuid: reply_to_uuid ?? null,
        note: 'Not sent.',
      }),
    },
    'low'
  ),
  tiered(
    {
      name: 'create_rotation_rule',
      description:
        'Create a rotation rule (lead bank to a campaign on a cron). It is created INACTIVE; turning it on is activate_rule, which needs approval.',
      inputSchema: z.object({
        name: z.string().min(1).max(200),
        campaign_id: id,
        cron: z.string().min(9).max(100).describe("5-field cron in UTC, e.g. '0 8 * * 1-5'"),
        filter: leadFilter.optional(),
        daily_cap: z.number().int().min(1).max(1000).optional(),
        order_by: z.enum(['newest', 'oldest']).optional(),
      }),
      run: async (input, { call }) => ({
        created: await call('/api/rules', { method: 'POST', body: { ...input, filter: input.filter ?? {} } }),
      }),
    },
    'low'
  ),
  tiered(
    {
      name: 'notify',
      description: "Send the owner a short Telegram message (status, a finished summary). Not for lead-facing email.",
      inputSchema: z.object({ text: z.string().min(1).max(1500) }),
      run: async ({ text }, { deps }) => {
        if (!deps.notify) throw new Error('notify is not configured')
        const sent = await deps.notify(`Lume agent: ${text}`)
        if (!sent.ok) throw new Error(`telegram: ${sent.error ?? 'not sent'}`)
        return { status: 'sent' }
      },
    },
    'low'
  ),

  // high ---------------------------------------------------------------------
  tiered(
    {
      name: 'decide_validation',
      description:
        "Press a validation gate button, i.e. send its callback_data (e.g. 'ingest_ok:<id>'), as a Telegram tap would. Use get_validation_queue for valid buttons. Pushes and campaign launches are not allowed here (use activate_campaign).",
      inputSchema: z.object({
        callback_data: z
          .string()
          .regex(/^[a-z_]+:[A-Za-z0-9:_-]+$/)
          .max(128)
          .refine((v) => !BLOCKED_GATE_ACTIONS.has(v.split(':')[0]), 'this button needs its own confirmation flow'),
        job_id: uuid.optional().describe('the validation job this gate belongs to, when it is one'),
        summary,
      }),
      payload: ({ callback_data, job_id, summary: s }) => ({
        callback_data,
        ...(job_id ? { job_id: job_id.toLowerCase() } : {}),
        summary: s ?? `Press gate button ${callback_data}`,
      }),
    },
    'high'
  ),
  tiered(
    {
      name: 'assign_leads',
      description: 'Queue lead-bank leads matching a filter into a campaign.',
      inputSchema: z.object({
        campaign_id: id,
        filter: leadFilter,
        limit: z.number().int().min(1).max(5000).optional(),
        summary,
      }),
      payload: ({ campaign_id, filter, limit, summary: s }) => ({
        campaign_id,
        filter: json(filter),
        limit: limit ?? null,
        summary: s ?? `Assign${limit ? ` up to ${limit}` : ''} leads to campaign ${campaign_id}`,
      }),
    },
    'high'
  ),
  tiered(
    {
      name: 'activate_rule',
      description: 'Turn a rotation rule on so it runs on its cron.',
      inputSchema: z.object({ rule_id: uuid, summary }),
      payload: ({ rule_id, summary: s }) => ({ rule_id: rule_id.toLowerCase(), summary: s ?? `Activate rotation rule ${rule_id}` }),
    },
    'high'
  ),
  tiered(
    {
      name: 'send_reply',
      description: 'Send an email reply to a lead through Instantly.',
      inputSchema: z.object({
        reply_to_uuid: id.describe('Instantly email id being replied to'),
        body: z.string().min(1).max(10000),
        eaccount: z.string().max(320).optional().describe('sending account (inbox) address'),
        campaign_id: id.optional(),
        summary,
      }),
      payload: ({ reply_to_uuid, body, eaccount, campaign_id, summary: s }) => ({
        reply_to_uuid,
        body,
        eaccount: eaccount ?? null,
        campaign_id: campaign_id ?? null,
        summary: s ?? `Send reply: "${body.slice(0, 80)}${body.length > 80 ? '…' : ''}"`,
      }),
    },
    'high'
  ),
  tiered(
    {
      name: 'pause_campaign',
      description: 'Pause an Instantly campaign.',
      inputSchema: z.object({ campaign_id: id, summary }),
      payload: ({ campaign_id, summary: s }) => ({ campaign_id, summary: s ?? `Pause campaign ${campaign_id}` }),
    },
    'high'
  ),
  tiered(
    {
      name: 'resume_campaign',
      description: 'Resume a paused Instantly campaign.',
      inputSchema: z.object({ campaign_id: id, summary }),
      payload: ({ campaign_id, summary: s }) => ({ campaign_id, summary: s ?? `Resume campaign ${campaign_id}` }),
    },
    'high'
  ),
  tiered(
    {
      name: 'activate_campaign',
      description: "Launch the campaign a validation job was pushed to (the job's camp_launch step).",
      inputSchema: z.object({ job_id: uuid, summary }),
      payload: ({ job_id, summary: s }) => ({
        job_id: job_id.toLowerCase(),
        summary: s ?? `Launch the campaign for job ${job_id}`,
      }),
    },
    'high'
  ),
  tiered(
    {
      name: 'duplicate_campaign',
      description: "Create a new Instantly campaign copying a source campaign's schedule, sending accounts and daily limit.",
      inputSchema: z.object({ source_campaign_id: id, name: z.string().min(1).max(200), summary }),
      payload: ({ source_campaign_id, name, summary: s }) => ({
        source_campaign_id,
        name,
        summary: s ?? `Duplicate campaign ${source_campaign_id} as "${name}"`,
      }),
    },
    'high'
  ),
  tiered(
    {
      name: 'delete_rule',
      description: 'Delete a rotation rule.',
      inputSchema: z.object({ rule_id: uuid, summary }),
      payload: ({ rule_id, summary: s }) => ({ rule_id: rule_id.toLowerCase(), summary: s ?? `Delete rotation rule ${rule_id}` }),
    },
    'high'
  ),
]

export function buildTools(deps: ToolDeps): AgentTool[] {
  const call = routeCaller(deps)
  return SPECS.map((build) => build(deps, call))
}
