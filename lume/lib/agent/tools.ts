import { z } from 'zod'
import type { Json, PendingActionKind } from '@/lib/db/types'
import { HIGH_RISK_KIND, TOOL_TIERS, type ToolName, type ToolTier } from '@/lib/agent/permissions'
import { describeStep, newSkillSchema, placeholdersIn, skillStepSchema, skillVariableSchema, type NewSkill, type Skill } from '@/lib/agent/skillModel'

/**
 * The orb agent's tools. Each one is declared once with `tiered(spec, tier)`:
 *
 *  - read / low: `run` calls one of Lume's own `/api/*` routes with
 *    `Authorization: Bearer ${LUME_INTERNAL_SECRET}` (the same guard the UI
 *    passes through), or drafts / notifies. Never Supabase or Instantly.
 *  - high: the spec carries only a `payload` builder producing the same
 *    request a Lume click would send (`{ kind, payload }` of POST
 *    /api/actions). `tiered` gives it a `run` that passes it through
 *    `deps.prepare` (server-side: `buildActionRequest` in
 *    lib/actions/build.ts — the route's own builder, so count, names and the
 *    summary are computed exactly as for a click), then calls
 *    `createAction(kind, payload, 'agent', { agentRunId, ruleId })` and returns
 *    `{ status: 'awaiting_approval', action_id, deep_link }`. There is no code
 *    path from a high-risk tool to a route or a write adapter.
 *
 * Pure (deps injected) so the tiering is unit-tested without a network.
 * `toRunnableTools` in `lib/agent/runnable.ts` adapts these for the SDK runner.
 */

export type ToolResult = Record<string, unknown>

export interface CreatedAction {
  id: string
}

/** Server-side snapshot builder (`buildActionRequest`), injected so this module stays pure. */
export type PrepareAction = (request: { kind: PendingActionKind; payload: Record<string, Json> }) => Promise<
  | { ok: true; kind: PendingActionKind; payload: Record<string, Json> & { summary: string }; ruleId?: string }
  | { ok: false; status: number; error: string }
>

export interface ToolDeps {
  fetch: (url: string, init: RequestInit & { headers: Record<string, string> }) => Promise<Response>
  createAction: (
    kind: PendingActionKind,
    payload: Record<string, Json>,
    requestedBy: 'agent',
    meta: { agentRunId: string; ruleId?: string | null }
  ) => Promise<CreatedAction>
  prepare: PrepareAction
  agentRunId: string
  /** Lume's own origin (the run route passes `internalOrigin(req)`). Defaults to `LUME_INTERNAL_URL`. */
  baseUrl?: string
  /** Defaults to `LUME_INTERNAL_SECRET`. */
  secret?: string
  /** Telegram message to the owner (the `notify` tool). */
  notify?: (text: string) => Promise<{ ok: boolean; error?: string }>
  /** Saved skills (`lib/agent/skills.ts`), injected server-side; skill tools fail cleanly without it. */
  skills?: SkillStore
  /** The conversation this run belongs to (recorded as a saved skill's source). */
  conversationId?: string
}

/** What the skill tools need from storage. */
export interface SkillStore {
  list: () => Promise<Skill[]>
  get: (id: string) => Promise<Skill | null>
  findByName: (name: string) => Promise<Skill | null>
  create: (skill: NewSkill) => Promise<Skill>
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
  /** The request payload (as POST /api/actions takes it); the server builds the snapshot and summary. */
  payload: (input: z.infer<S>) => Record<string, Json>
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
  request: Record<string, Json>
): Promise<ToolResult> {
  const built = await deps.prepare({ kind, payload: request })
  if (!built.ok) throw new Error(`${kind} refused: ${built.error} (HTTP ${built.status})`)
  try {
    const meta = built.ruleId ? { agentRunId: deps.agentRunId, ruleId: built.ruleId } : { agentRunId: deps.agentRunId }
    const action = await deps.createAction(built.kind, built.payload, 'agent', meta)
    return {
      status: 'awaiting_approval',
      action_id: action.id,
      deep_link: `/actions/${action.id}`,
      summary: built.payload.summary,
    }
  } catch (err) {
    // Same action already waiting (same job / rule / campaign / reply): point at it rather than fail.
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
  const base = (deps.baseUrl ?? process.env.LUME_INTERNAL_URL ?? 'http://localhost:3000').replace(/\/+$/, '')
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
/** Campaign ids as lume_campaigns / rules store them (lib/rules/schema.ts CAMPAIGN_ID_RE). */
const campaignId = z.string().regex(/^[A-Za-z0-9_:-]{1,80}$/, 'campaign id')
// Mirrors lib/rules/filter.ts ruleFilterSchema (kept transform-free so it converts to JSON Schema).
const leadFilter = z
  .strictObject({
    source: z
      .enum(['validation_rows', 'lead_bank'])
      .optional()
      .describe("default 'validation_rows' (validated, unassigned); 'lead_bank' = leads already queued for another campaign"),
    icp_status: z.string().max(64).optional(),
    city: z.string().max(120).optional().describe('case-insensitive contains match'),
    since: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}/)
      .max(40)
      .optional()
      .describe('ISO date lower bound on created_at'),
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
      description: 'All campaigns Lume tracks (Instantly and others) with status and headline numbers (sent, replies, reply rate, opportunities, bounced).',
      inputSchema: z.object({}),
      run: async (_i, { call }) => call('/api/campaigns?with=analytics') as Promise<ToolResult>,
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
      name: 'get_campaign_sequence',
      description:
        "An Instantly campaign's full email sequence as plain text: every step (with its delay) and every variant's subject and body, " +
        'plus any sequence edit already awaiting approval. Read it before drafting changes with update_campaign_sequence.',
      inputSchema: z.object({ campaign_id: campaignId }),
      run: async ({ campaign_id }, { call }) => ({
        sequence: await call(`/api/campaigns/${encodeURIComponent(campaign_id)}/sequence/edit`),
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

  tiered(
    {
      name: 'open_website',
      description:
        "Open a public web page from Lume's server and read it: title, meta description, readable text (up to 20k chars) and the site's own links " +
        '(use them to open About, Customers, Pricing or Careers next). Accepts a bare domain like "d3.com". Use it when web_fetch fails or is blocked.',
      inputSchema: z.object({ url: z.string().min(3).max(2000) }),
      run: async ({ url }, { call }) => call(`/api/web/page?url=${encodeURIComponent(url)}`) as Promise<ToolResult>,
    },
    'read'
  ),
  tiered(
    {
      name: 'search_apify_store',
      description:
        'Search the Apify Store for actors (scrapers) that can source leads, e.g. "google maps roofers" or "linkedin company employees". ' +
        'Returns a ranked shortlist: id (username/name), title, rating, users (30 days), 30-day success rate, pricing model and price, ' +
        'and whether Lume can run it under the $20 cap per run (runnable). Recommend 2-3 runnable ones with reasons.',
      inputSchema: z.object({
        query: z.string().min(2).max(200),
        limit: z.number().int().min(1).max(20).optional(),
      }),
      run: async ({ query, limit }, { call }) =>
        call(`/api/apify/store?q=${encodeURIComponent(query)}&limit=${limit ?? 8}`) as Promise<ToolResult>,
    },
    'read'
  ),
  tiered(
    {
      name: 'get_actor_input_schema',
      description:
        "An Apify actor's input fields (required first, then the ones it suggests values for), its pricing and whether a run fits the $20 cap. " +
        'ALWAYS call this before run_apify_actor, then show the owner the required and important fields with a suggested value for each ' +
        '(from the default, the prefill or the owner\'s goal) and ASK the owner for the inputs. Wait for their answer; never invent inputs.',
      inputSchema: z.object({ actor_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}[/~][A-Za-z0-9][A-Za-z0-9._-]{0,99}$/, 'username/name') }),
      run: async ({ actor_id }, { call }) => call(`/api/apify/actor?id=${encodeURIComponent(actor_id)}`) as Promise<ToolResult>,
    },
    'read'
  ),
  tiered(
    {
      name: 'get_actor_run',
      description:
        "Status of an Apify actor run started by an approved run_apify_actor (the run_id is in the action's result; ask the owner or check the action page if unknown): status, items so far, cost so far, limits.",
      inputSchema: z.object({ run_id: z.string().regex(/^[A-Za-z0-9]{8,40}$/, 'Apify run id') }),
      run: async ({ run_id }, { call }) => call(`/api/apify/runs/${encodeURIComponent(run_id)}`) as Promise<ToolResult>,
    },
    'read'
  ),
  tiered(
    {
      name: 'rank_campaigns',
      description:
        'Past campaigns ranked by reply rate (then opportunities), only those with enough sends to trust the rate. ' +
        'Use it to recommend which campaign to duplicate for a new launch, quoting the numbers.',
      inputSchema: z.object({
        min_sent: z.number().int().min(0).max(100_000).optional().describe('default 100'),
        limit: z.number().int().min(1).max(20).optional(),
      }),
      run: async ({ min_sent, limit }, { call }) => {
        const table = (await call('/api/campaigns?with=analytics')) as {
          campaigns?: { name: string; instantly_id: string | null; status: string; sent: number | null; replies: number | null; reply_rate: number | null; opportunities: number | null; bounced: number | null }[]
          instantly?: string
        }
        const floor = min_sent ?? 100
        const rows = (table.campaigns ?? []).filter((c) => (c.sent ?? 0) >= floor && c.reply_rate !== null)
        rows.sort((a, b) => (b.reply_rate ?? 0) - (a.reply_rate ?? 0) || (b.opportunities ?? 0) - (a.opportunities ?? 0))
        return {
          instantly: table.instantly ?? null,
          min_sent: floor,
          ranked: rows.slice(0, limit ?? 5).map((c) => ({
            name: c.name,
            campaign_id: c.instantly_id,
            status: c.status,
            sent: c.sent,
            replies: c.replies,
            reply_rate_pct: c.reply_rate,
            opportunities: c.opportunities,
            bounce_rate_pct: c.sent && c.bounced !== null ? Math.round((c.bounced / c.sent) * 1000) / 10 : null,
          })),
          considered: rows.length,
        }
      },
    },
    'read'
  ),

  // low ----------------------------------------------------------------------
  tiered(
    {
      name: 'import_actor_run',
      description:
        "Bring a finished Apify run's results into Lume's Import flow. This only stages them: the import waits at the usual Approve/Deny ingest gate " +
        'and then goes through validation; nothing is pushed to Instantly. Works for a SUCCEEDED run, or a timed-out/aborted one that has items (partial results).',
      inputSchema: z.object({ run_id: z.string().regex(/^[A-Za-z0-9]{8,40}$/, 'Apify run id') }),
      run: async ({ run_id }, { call }) => {
        const run = (await call(`/api/apify/runs/${encodeURIComponent(run_id)}`)) as {
          status: string
          dataset_id: string | null
          item_count: number | null
        }
        const finished = run.status === 'SUCCEEDED' || ((run.status === 'TIMED-OUT' || run.status === 'ABORTED') && (run.item_count ?? 0) > 0)
        if (!finished) return { status: 'not_ready', run_status: run.status, item_count: run.item_count, note: 'Import once the run has finished.' }
        if (!run.dataset_id) return { status: 'no_dataset', run_status: run.status }
        const imported = await call('/api/import/apify', { method: 'POST', body: { dataset_id: run.dataset_id } })
        return {
          status: 'staged',
          run_status: run.status,
          partial: run.status !== 'SUCCEEDED',
          imported,
          note: 'Waiting at the ingest gate (Approve/Deny in Lume Validate or Telegram).',
        }
      },
    },
    'low'
  ),
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
        name: z.string().min(1).max(80),
        campaign_id: campaignId,
        cron: z.string().min(9).max(100).describe("5-field cron in the owner's time zone (America/Los_Angeles), at most every 15 minutes, e.g. '0 8 * * 1-5'"),
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
  // Each payload is the POST /api/actions request for its kind; the server
  // (deps.prepare → buildActionRequest) builds the confirmed snapshot.
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
      }),
      payload: ({ callback_data, job_id }) => ({
        callback_data,
        ...(job_id ? { job_id: job_id.toLowerCase() } : {}),
      }),
    },
    'high'
  ),
  tiered(
    {
      name: 'assign_leads',
      description:
        'Queue lead-bank leads matching a filter into a campaign (the same as dragging "all N matching" onto its card). The owner sees the matching count before approving; limit takes at most that many.',
      inputSchema: z.object({
        campaign_id: campaignId,
        filter: leadFilter,
        limit: z.number().int().min(1).max(100_000).optional().describe('at most this many leads; default all matching'),
      }),
      payload: ({ campaign_id, filter, limit }) => ({
        campaign_id,
        filter: json(filter),
        ...(limit ? { limit } : {}),
      }),
    },
    'high'
  ),
  tiered(
    {
      name: 'activate_rule',
      description: 'Turn a rotation rule on so it runs on its cron (each run still asks before assigning).',
      inputSchema: z.object({ rule_id: uuid }),
      payload: ({ rule_id }) => ({ rule_id: rule_id.toLowerCase() }),
    },
    'high'
  ),
  tiered(
    {
      name: 'send_reply',
      description: 'Send an email reply to a lead through Instantly. Get eaccount and reply_to_uuid from the campaign inbox.',
      inputSchema: z.object({
        eaccount: z.email().max(320).describe('our sending account (inbox) address'),
        reply_to_uuid: id.describe('Instantly email id being replied to'),
        body: z.string().min(1).max(20_000),
        subject: z.string().max(300).optional(),
        campaign_id: id.optional(),
        lead_email: z.string().max(300).optional(),
      }),
      payload: ({ eaccount, reply_to_uuid, body, subject, campaign_id, lead_email }) => ({
        eaccount,
        reply_to_uuid,
        body,
        ...(subject ? { subject } : {}),
        ...(campaign_id ? { campaign_id } : {}),
        ...(lead_email ? { lead_email } : {}),
      }),
    },
    'high'
  ),
  tiered(
    {
      name: 'pause_campaign',
      description: 'Pause an Instantly campaign.',
      inputSchema: z.object({ campaign_id: id, campaign_name: z.string().max(300).optional() }),
      payload: ({ campaign_id, campaign_name }) => ({ campaign_id, ...(campaign_name ? { campaign_name } : {}) }),
    },
    'high'
  ),
  tiered(
    {
      name: 'resume_campaign',
      description: 'Resume a paused Instantly campaign.',
      inputSchema: z.object({ campaign_id: id, campaign_name: z.string().max(300).optional() }),
      payload: ({ campaign_id, campaign_name }) => ({ campaign_id, ...(campaign_name ? { campaign_name } : {}) }),
    },
    'high'
  ),
  tiered(
    {
      name: 'activate_campaign',
      description:
        "Launch the campaign a validation job was pushed to (the job's camp_launch step). The job must be pushed (instantly status done).",
      inputSchema: z.object({ job_id: uuid }),
      payload: ({ job_id }) => ({ job_id: job_id.toLowerCase() }),
    },
    'high'
  ),
  tiered(
    {
      name: 'duplicate_campaign',
      description: "Create a new Instantly campaign copying a source campaign's schedule, sending accounts and daily limit.",
      inputSchema: z.object({
        source_campaign_id: id,
        name: z.string().min(1).max(200),
        campaign_name: z.string().max(300).optional().describe('the source campaign name, for the summary'),
      }),
      payload: ({ source_campaign_id, name, campaign_name }) => ({
        source_campaign_id,
        name,
        ...(campaign_name ? { campaign_name } : {}),
      }),
    },
    'high'
  ),
  tiered(
    {
      name: 'run_apify_actor',
      description:
        'Propose an Apify actor run to source leads. Only after get_actor_input_schema AND the owner has answered with the inputs in this chat: ' +
        'pass exactly the inputs they agreed (field names from the schema; no invented fields or values). ' +
        'The server validates the input against the actor schema and caps the run at $20 (or the lower max_charge_usd); ' +
        'the approval shows the actor, the inputs, the cost estimate and the cap. After approval the run starts; check it with get_actor_run.',
      inputSchema: z.object({
        actor_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}[/~][A-Za-z0-9][A-Za-z0-9._-]{0,99}$/, 'username/name'),
        input: z.record(z.string(), z.unknown()).describe('the actor input the owner confirmed'),
        max_charge_usd: z.number().positive().max(20).optional().describe('budget for this run, at most 20 (default 20)'),
        expected_items: z.number().int().positive().max(1_000_000).optional().describe('results the owner expects, for the estimate'),
        inputs_confirmed_by_owner: z.literal(true).describe('true only if the owner answered with or approved these exact inputs in this chat'),
      }),
      payload: ({ actor_id, input, max_charge_usd, expected_items }) => ({
        actor_id,
        input: input as Json,
        ...(max_charge_usd !== undefined ? { max_charge_usd } : {}),
        ...(expected_items !== undefined ? { expected_items } : {}),
      }),
    },
    'high'
  ),
  tiered(
    {
      name: 'update_campaign_sequence',
      description:
        "Replace an Instantly campaign's email sequence with an edited version. Pass the COMPLETE sequence (every step, " +
        'in order, every variant) as plain text, starting from get_campaign_sequence; steps you leave out are removed. ' +
        'Line breaks in body are kept. Variables like {{firstName}} pass through. The owner sees a before/after diff.',
      inputSchema: z.object({
        campaign_id: campaignId,
        steps: z
          .array(
            z.object({
              delay: z.number().min(0).max(527_040).describe('wait before this step; 0 for the first email'),
              delay_unit: z.enum(['minutes', 'hours', 'days']).optional().describe('default days'),
              variants: z
                .array(
                  z.object({
                    subject: z.string().max(500).describe('empty on follow-ups = same thread'),
                    body: z.string().min(1).max(20_000),
                    disabled: z.boolean().optional(),
                  })
                )
                .min(1)
                .max(26),
            })
          )
          .min(1)
          .max(20),
      }),
      payload: ({ campaign_id, steps }) => ({
        campaign_id,
        steps: steps.map((st) => ({
          delay: st.delay,
          delay_unit: st.delay_unit ?? 'days',
          variants: st.variants.map((v) => ({ subject: v.subject, body: v.body, ...(v.disabled ? { disabled: true } : {}) })),
        })),
      }),
    },
    'high'
  ),
  tiered(
    {
      name: 'delete_rule',
      description: 'Delete a rotation rule.',
      inputSchema: z.object({ rule_id: uuid }),
      payload: ({ rule_id }) => ({ rule_id: rule_id.toLowerCase() }),
    },
    'high'
  ),
  // skills (saved pipelines) -------------------------------------------------
  tiered(
    {
      name: 'list_skills',
      description: "List the owner's saved skills (re-runnable pipelines): name, description, steps outline, variables, run count.",
      inputSchema: z.object({}),
      run: async (_input, { deps }) => {
        const skills = await skillStore(deps).list()
        return {
          skills: skills.map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description,
            steps: s.steps.map(describeStep),
            variables: s.variables.map((v) => v.name),
            run_count: s.run_count,
            last_run_at: s.last_run_at,
          })),
        }
      },
    },
    'read'
  ),
  tiered(
    {
      name: 'get_skill',
      description: 'Get one saved skill in full (steps with input templates, variables) by id or by name.',
      inputSchema: z.object({ id: uuid.optional(), name: z.string().min(1).max(80).optional() }).refine((v) => v.id || v.name, 'id or name'),
      run: async ({ id: skillId, name }, { deps }) => {
        const store = skillStore(deps)
        const skill = skillId ? await store.get(skillId.toLowerCase()) : await store.findByName(name ?? '')
        if (!skill) throw new Error(`No saved skill ${skillId ? `with id ${skillId}` : `named "${name}"`}`)
        return { skill }
      },
    },
    'read'
  ),
  tiered(
    {
      name: 'save_skill',
      description:
        "Save the pipeline built in this conversation as a reusable skill. Only call after the owner said yes and confirmed the name. Distil it: actor inputs become input_template with the values the owner may change replaced by {{variable}} placeholders (declared in variables with a description and the value used this time as default); record the source campaign for duplicate_campaign. Steps in order; types: apify_actor, import, validate, duplicate_campaign, assign_leads, rotation_rule, launch, note.",
      inputSchema: z.object({
        name: z.string().min(1).max(80),
        description: z.string().max(1000).optional(),
        steps: z.array(skillStepSchema).min(1).max(30),
        variables: z.array(skillVariableSchema).max(20).optional(),
      }),
      run: async (input, { deps }) => {
        const parsed = newSkillSchema.safeParse({ ...input, source_conversation_id: deps.conversationId ?? null })
        if (!parsed.success) throw new Error(`Skill refused: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
        const declared = new Set(parsed.data.variables.map((v) => v.name))
        const undeclared = placeholdersIn(parsed.data.steps).filter((n) => !declared.has(n))
        if (undeclared.length) throw new Error(`Skill refused: placeholders without a variable: ${undeclared.join(', ')}`)
        const skill = await skillStore(deps).create(parsed.data)
        return { status: 'saved', skill_id: skill.id, name: skill.name, steps: skill.steps.length }
      },
    },
    'low'
  ),
]

function skillStore(deps: ToolDeps): SkillStore {
  if (!deps.skills) throw new Error('Saved skills are not available in this context')
  return deps.skills
}

export function buildTools(deps: ToolDeps): AgentTool[] {
  const call = routeCaller(deps)
  return SPECS.map((build) => build(deps, call))
}
