import { z } from 'zod'
import type { Json, PendingActionKind } from '@/lib/db/types'
import { HIGH_RISK_KIND, TOOL_TIERS, skippable, type ToolName, type ToolTier } from '@/lib/agent/permissions'
import { FilterCriteria } from '@/lib/review/model'
import { APOLLO_STEPS } from '@/lib/apollo/records'
import { parseLeadQuery } from '@/lib/adapters/instantlyLeads.map'
import { EmailId, INTEREST_NAMES, LabelBody } from '@/lib/inbox/schemas'
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
 *    path from a high-risk tool to a route or a write adapter. In
 *    skip-permissions mode a skippable kind (lib/agent/permissions.ts) is then
 *    handed to `deps.autoApprove` (claim as 'agent' + execute, server-side)
 *    and returns `auto_approved` with the outcome; a duplicate never is, nor a
 *    kind the builder remapped.
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
  /**
   * The project this run's conversation is filed in (server-set from the
   * conversation row). read_project_file reads only from it; the model never
   * names a project.
   */
  projectId?: string | null
  /**
   * The Grok Bot running this chat, if any. A vertical (non-master) bot does
   * not get the vertical-management tools (MASTER_ONLY_TOOLS); list_verticals stays.
   */
  operator?: { is_master: boolean } | null
  /** Skip-permissions mode for this run: skippable kinds are approved + executed at once. */
  skipPermissions?: boolean
  /** Claims (decided_via 'agent') and executes a pending action. Server-side only. */
  autoApprove?: (actionId: string) => Promise<{
    /**
     * handled_elsewhere: someone else claimed or ran it first; result carries the row status.
     * failed with result `{ still_awaiting: true }`: the claim was never made, so it still awaits the owner.
     */
    status: 'executed' | 'failed' | 'handled_elsewhere'
    result: Record<string, Json> | null
    error: string | null
  }>
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

type RouteCall = (path: string, init?: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown }) => Promise<unknown>

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
      description:
        `${spec.description} Needs the owner's approval: this only creates a pending action and returns awaiting_approval; it does not run.` +
        (skippable(kind) ? ' If the owner has skip permissions on for this chat it may instead return auto_approved with the outcome (it ran).' : ''),
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
    // Fail closed: a builder that remaps the kind never inherits the tool's skip.
    if (deps.skipPermissions && deps.autoApprove && built.kind === kind && skippable(kind)) {
      const done = await deps.autoApprove(action.id)
      // The claim itself failed (nothing ran): an ordinary approval the owner still decides.
      if (done.result?.still_awaiting === true) {
        return {
          status: 'awaiting_approval',
          action_id: action.id,
          deep_link: `/actions/${action.id}`,
          summary: built.payload.summary,
          note: 'Skip mode could not auto-approve; it awaits the owner.',
        }
      }
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

/** Instantly-backed routes answer `{ configured: false }` without a key: say so instead of returning nothing. */
function configured(body: unknown): ToolResult {
  if (body && typeof body === 'object' && (body as { configured?: unknown }).configured === false) {
    throw new Error('Instantly is not configured (INSTANTLY_API_KEY missing in Lume), so this cannot be read. Nothing was guessed.')
  }
  return body as ToolResult
}

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
      description: 'Rules, active or not, with next and last run: rotation rules (kind rotate: lead bank to campaign on a cron) and cycle-out rules (kind cycle_out: remove finished no-reply leads, then refill; params after_days, refill_to).',
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
      name: 'list_campaign_leads',
      description:
        "Leads in one Instantly campaign by state: finished_no_reply (sequence completed, never replied), replied, bounced, contacted, interested, " +
        "or no_reply_after_days:N (contacted, no reply, last email at least N days ago). Returns each lead's id, email, name, status, last contact, " +
        'last reply, reply count and interest, plus matched (total in that state), a summary by status, and truncated when the scan hit its cap (2,000 leads; removals scan 5,000). Read-only.',
      inputSchema: z.object({
        campaign_id: campaignId,
        state: z
          .string()
          .max(40)
          .refine((v) => parseLeadQuery(v) !== null, 'finished_no_reply | replied | bounced | contacted | interested | no_reply_after_days:N (1-365)'),
        limit: z.number().int().min(1).max(1000).optional().describe('leads to return (default 100); matched counts all of them'),
      }),
      run: async ({ campaign_id, state, limit }, { call }) =>
        configured(
          await call(`/api/campaigns/${encodeURIComponent(campaign_id)}/leads?state=${encodeURIComponent(state)}&limit=${limit ?? 100}`)
        ),
    },
    'read'
  ),
  tiered(
    {
      name: 'contact_usage',
      description:
        "Instantly uploaded contacts vs the plan's limit (the contact cap): current, limit, headroom, used_pct, plan name. Deleting leads (remove_leads) frees room 5-10 minutes later.",
      inputSchema: z.object({}),
      run: async (_i, { call }) => configured(await call('/api/instantly/usage')),
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
      name: 'search_past_chats',
      description:
        'Search earlier Agent conversations (message text and titles, case-insensitive) for context: a client, an ICP agreed before, an actor used, a decision. Returns snippets with conversation ids and titles.',
      inputSchema: z.object({ query: z.string().min(2).max(200) }),
      run: async ({ query }, { call }) => call(`/api/agent/past-chats?q=${encodeURIComponent(query)}`) as Promise<ToolResult>,
    },
    'read'
  ),
  tiered(
    {
      name: 'read_project_file',
      description:
        "Read the extracted text of a file or note in this chat's project, by the id shown in the Project block's index. " +
        'Returns up to 20k characters from offset (default 0) and next_offset when there is more. Use it for items the block did not show in full.',
      inputSchema: z.object({ id: uuid, offset: z.number().int().min(0).max(1_000_000).optional() }).strict(),
      run: async ({ id, offset }, { call, deps }) => {
        if (!deps.projectId) throw new Error('This chat is not filed in a project, so there are no project files to read.')
        return call(`/api/agent/projects/${deps.projectId}/files/${id}?offset=${offset ?? 0}`) as Promise<ToolResult>
      },
    },
    'read'
  ),
  tiered(
    {
      name: 'remember',
      description:
        'Save one durable thing learned in chat so future chats know it: a client and their offer (client), an agreed ICP or target (fact), a standing preference or "never do X" (preference), or a decision (decision). ' +
        'One short self-contained sentence with names. Save sparingly: never transient status, numbers that change, or anything already saved.',
      inputSchema: z.object({ kind: z.enum(['preference', 'fact', 'client', 'decision']), content: z.string().min(3).max(500) }),
      run: async ({ kind, content }, { call, deps }) =>
        call('/api/agent/memory', { method: 'POST', body: { kind, content, conversation_id: deps.conversationId ?? null } }) as Promise<ToolResult>,
    },
    'low'
  ),
  tiered(
    {
      name: 'forget',
      description: 'Remove a saved memory that is wrong or no longer true: by memory_id, or by a phrase it contains (if several match, they are listed instead of removed).',
      inputSchema: z
        .object({ memory_id: uuid.optional(), match: z.string().min(3).max(200).optional() })
        .refine((v) => !!v.memory_id !== !!v.match, 'memory_id or match'),
      run: async ({ memory_id, match }, { call }) => {
        let id = memory_id
        if (!id) {
          const { memories } = (await call('/api/agent/memory')) as { memories: { id: string; kind: string; content: string }[] }
          const hits = memories.filter((m) => m.content.toLowerCase().includes(match!.toLowerCase()))
          if (hits.length !== 1) return { status: hits.length ? 'ambiguous' : 'not_found', candidates: hits.slice(0, 10) }
          id = hits[0].id
        }
        await call(`/api/agent/memory/${id}`, { method: 'DELETE' })
        return { status: 'forgotten', memory_id: id }
      },
    },
    'low'
  ),
  tiered(
    {
      name: 'load_actor_results',
      description:
        "Copy a finished Apify run's results (or a dataset, or a validation job's rows) into a lead review set (≤ 5,000 rows) so they can be inspected and filtered here before anything goes to Apollo. " +
        'Returns the set id, counts, coverage (website, phone, email, LinkedIn) and breakdowns by category, city and state. Opens the Leads panel next to the chat.',
      inputSchema: z
        .object({
          run_id: z.string().regex(/^[A-Za-z0-9]{8,40}$/).optional(),
          dataset_id: z.string().regex(/^[A-Za-z0-9]{8,40}$/).optional(),
          job_id: uuid.optional(),
          title: z.string().max(200).optional().describe('e.g. "Roofers · Austin (Google Maps)"'),
        })
        .refine((v) => [v.run_id, v.dataset_id, v.job_id].filter(Boolean).length === 1, 'exactly one of run_id, dataset_id, job_id'),
      run: async ({ run_id, dataset_id, job_id, title }, { call, deps }) => {
        const source = run_id ? { kind: 'run', id: run_id } : dataset_id ? { kind: 'dataset', id: dataset_id } : { kind: 'job', id: job_id!.toLowerCase() }
        return call('/api/review-sets', { method: 'POST', body: { source, conversation_id: deps.conversationId ?? null, ...(title ? { title } : {}) } }) as Promise<ToolResult>
      },
    },
    'low'
  ),
  tiered(
    {
      name: 'review_leads',
      description:
        'Read a lead review set: a page of rows (name, category, city, state, website/domain, phone, rating, reviews, LinkedIn, email; idx is the row number) plus the summary over kept rows. ' +
        'Filter the page by status (kept, excluded, all), a search string, category or city. Use it to show the owner a table and to spot junk (wrong categories, franchises, closed or tiny businesses, duplicates).',
      inputSchema: z.object({
        set_id: uuid,
        status: z.enum(['kept', 'excluded', 'all']).optional(),
        q: z.string().max(120).optional(),
        category: z.string().max(120).optional(),
        city: z.string().max(120).optional(),
        page: z.number().int().min(0).max(1000).optional(),
        page_size: z.number().int().min(1).max(100).optional(),
      }),
      run: async ({ set_id, status, q, category, city, page, page_size }, { call }) => {
        const params = new URLSearchParams({ status: status ?? 'kept', page: String(page ?? 0), page_size: String(page_size ?? 25) })
        if (q) params.set('q', q)
        if (category) params.set('category', category)
        if (city) params.set('city', city)
        const [summary, items] = await Promise.all([call(`/api/review-sets/${set_id}`), call(`/api/review-sets/${set_id}/items?${params}`)])
        return { ...(summary as Record<string, unknown>), page: items } as ToolResult
      },
    },
    'read'
  ),
  tiered(
    {
      name: 'filter_leads',
      description:
        "Exclude rows from a lead review set by structured criteria, ONLY after the owner asked for that filter. action 'exclude' drops kept rows that match; 'keep_only' drops kept rows that do not match. " +
        'Criteria combine with AND. Returns before/after counts, the new summary and a sample of what was dropped; quote them. Reversible with restore_leads (filter id).',
      inputSchema: z.object({
        set_id: uuid,
        action: z.enum(['exclude', 'keep_only']),
        criteria: FilterCriteria,
        reason: z.string().max(300).optional().describe("the owner's words, e.g. \"no website\""),
      }),
      run: async ({ set_id, action, criteria, reason }, { call }) =>
        call(`/api/review-sets/${set_id}/filter`, { method: 'POST', body: { action, criteria, ...(reason ? { reason } : {}) } }) as Promise<ToolResult>,
    },
    'low'
  ),
  tiered(
    {
      name: 'restore_leads',
      description: 'Undo exclusions in a lead review set: one filter (filter_id), specific rows (item_ids = idx values), or all.',
      inputSchema: z
        .object({ set_id: uuid, filter_id: z.string().max(40).optional(), item_ids: z.array(z.number().int().min(0)).max(5000).optional(), all: z.boolean().optional() })
        .refine((v) => !!v.filter_id || !!v.item_ids?.length || v.all === true, 'filter_id, item_ids or all'),
      run: async ({ set_id, ...what }, { call }) => call(`/api/review-sets/${set_id}/restore`, { method: 'POST', body: what }) as Promise<ToolResult>,
    },
    'low'
  ),
  tiered(
    {
      name: 'export_for_apollo',
      description:
        "Export ONLY the kept rows of a lead review set as a CSV in Apollo's import columns, for the owner to enrich manually in Apollo (find decision makers' emails and LinkedIn). " +
        'Returns a download link and the steps; nothing is sent to Apollo. The enriched file comes back through Import (CSV) and the usual gates.',
      inputSchema: z.object({ set_id: uuid }),
      run: async ({ set_id }, { call }) => {
        const r = (await call(`/api/review-sets/${set_id}`)) as { set: { title: string }; summary: { kept: number; coverage: Record<string, number> } }
        if (!r.summary.kept) return { status: 'nothing_kept', note: 'Every row is excluded; restore some first.' }
        return {
          status: 'ready',
          download: `/api/review-sets/${set_id}/export`,
          rows: r.summary.kept,
          coverage: r.summary.coverage,
          title: r.set.title,
          steps: APOLLO_STEPS,
          note: 'Give the owner the download link as a Markdown link and the steps. Lume does not send anything to Apollo.',
        }
      },
    },
    'low'
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
        'Use it after launch to compare performance, or when the owner asks which past campaign worked best. ' +
        'Never use it to pick a template for a new campaign: a new campaign has no copy, leads or sends to rank yet.',
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
  // inbox manager (Phase 3a-3c) -----------------------------------------------
  tiered(
    {
      name: 'list_replies',
      description:
        'Received replies in an Instantly campaign inbox, newest first: reply_to_uuid (the email id to reply to), thread_id, eaccount (our inbox that received it), ' +
        'lead_email, subject, a quote-trimmed excerpt, unread, interest (Instantly status). Filter by campaign, unread, interest (interested, ooo, not_interested, ' +
        'wrong_person, lost, meeting_booked, …), limit. Instantly allows 20 inbox reads a minute: answers are cached; a rate_limited error says how long to wait.',
      inputSchema: z.object({
        campaign_id: campaignId.optional(),
        unread: z.boolean().optional(),
        interest: z.enum(INTEREST_NAMES).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      run: async ({ campaign_id, unread, interest, limit }, { call }) => {
        const q = new URLSearchParams()
        if (campaign_id) q.set('campaign_id', campaign_id)
        if (unread !== undefined) q.set('unread', String(unread))
        if (interest) q.set('interest', interest)
        if (limit) q.set('limit', String(limit))
        const qs = q.toString()
        return configured(await call(`/api/inbox/replies${qs ? `?${qs}` : ''}`))
      },
    },
    'read'
  ),
  tiered(
    {
      name: 'get_thread',
      description:
        'One email conversation in full, oldest to newest, quotes trimmed, by an email id in it (reply_to_uuid) or its thread_id. ' +
        'latest_inbound is what a reply answers (its reply_to_uuid and our eaccount). Read it before drafting.',
      inputSchema: z
        .object({ reply_to_uuid: EmailId.optional(), thread_id: EmailId.optional() })
        .refine((v) => !!v.reply_to_uuid !== !!v.thread_id, 'exactly one of reply_to_uuid or thread_id'),
      run: async ({ reply_to_uuid, thread_id }, { call }) => {
        const q = reply_to_uuid ? `reply_to_uuid=${encodeURIComponent(reply_to_uuid)}` : `thread_id=${encodeURIComponent(thread_id ?? '')}`
        return configured(await call(`/api/inbox/thread?${q}`))
      },
    },
    'read'
  ),
  tiered(
    {
      name: 'label_reply',
      description:
        'Label a reply: sets the lead\'s Instantly interest status and moves its CRM deal. category: interested, not_now, wrong_person, not_interested, ooo, ' +
        'unsubscribe, hostile, booked; or verdict BAD (bad fit) without one. unsubscribe and hostile also add the address to the Instantly blocklist; ' +
        'BAD blocks only with block: true. Not interested / unsubscribe / hostile / BAD file a CRM Lost close for approval. Sends nothing.',
      inputSchema: LabelBody,
      run: async (input, { call }) => ({ labeled: await call('/api/inbox/label', { method: 'POST', body: input }) }),
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
      name: 'create_cycle_out_rule',
      description:
        'Create a cycle-out rule for one Instantly campaign: on its cron (default daily 07:00 Pacific) it asks to remove leads whose sequence finished more than after_days ago with no reply ' +
        '(never replied, interested or bounced leads; each removal is snapshotted), then, with refill_to, asks to top the campaign back up to that many leads from the lead bank (only after a removal; a run with nothing to remove refills nothing). ' +
        'It is created INACTIVE; turning it on is activate_rule, which needs approval. Each run still asks before removing or assigning.',
      inputSchema: z.object({
        name: z.string().min(1).max(80),
        campaign_id: campaignId,
        after_days: z.number().int().min(1).max(365).optional().describe('days since the last email before a finished lead is removed (default 14)'),
        refill_to: z.number().int().min(1).max(100_000).optional().describe('target leads in the campaign after removal; refilled from the lead bank'),
        refill_filter: leadFilter.optional().describe('which lead-bank leads refill it (default unassigned validated leads)'),
        max_per_run: z.number().int().min(1).max(1000).optional().describe('most leads removed per run (default 1000)'),
        cron: z.string().min(9).max(100).optional().describe("5-field cron in the owner's time zone, default '0 7 * * *' (daily 07:00)"),
      }),
      run: async ({ name, campaign_id, after_days, refill_to, refill_filter, max_per_run, cron }, { call }) => ({
        created: await call('/api/rules', {
          method: 'POST',
          body: {
            name,
            campaign_id,
            kind: 'cycle_out',
            cron: cron ?? '0 7 * * *',
            params: { after_days: after_days ?? 14, ...(refill_to ? { refill_to } : {}) },
            filter: refill_filter ?? {},
            ...(max_per_run ? { daily_cap: max_per_run } : {}),
          },
        }),
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
      description: 'Turn a rotation or cycle-out rule on so it runs on its cron (each run still asks before assigning or removing).',
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
      description:
        "Create a new Instantly campaign that copies a source campaign's settings: sending inboxes, schedule and daily limit (not its performance, and the copy is replaced afterwards with update_campaign_sequence). " +
        'Pick the source by which inboxes and schedule fit the new campaign, and describe it to the owner as "copy settings from <campaign>".',
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
  tiered(
    {
      name: 'remove_leads',
      description:
        'Delete leads from an Instantly campaign to free the contact cap (only deleting frees it, 5-10 minutes later). Pick them by lead_ids (from list_campaign_leads) ' +
        'or by state: finished_no_reply, bounced, or no_reply_after_days (with older_than_days); older_than_days also narrows the other states by last contact. ' +
        'Replied and interested leads are ALWAYS skipped, whatever you pass. Each lead is snapshotted in Lume before deletion and its CRM deal stays. ' +
        'At most 1,000 leads per request; the approval shows the count and campaign.',
      inputSchema: z
        .object({
          campaign_id: campaignId,
          lead_ids: z.array(id).min(1).max(1000).optional(),
          state: z.enum(['finished_no_reply', 'bounced', 'no_reply_after_days']).optional(),
          older_than_days: z.number().int().min(1).max(365).optional(),
          reason: z.string().trim().min(1).max(300).describe('why, shown on the approval and kept with the snapshot'),
        })
        .refine((v) => (v.lead_ids ? !v.state && v.older_than_days === undefined : !!v.state), 'lead_ids, or state (+ older_than_days), not both')
        .refine((v) => v.state !== 'no_reply_after_days' || v.older_than_days !== undefined, 'no_reply_after_days needs older_than_days'),
      payload: ({ campaign_id, lead_ids, state, older_than_days, reason }): Record<string, Json> =>
        lead_ids
          ? { campaign_id, lead_ids, reason }
          : { campaign_id, filter: { state: state ?? null, ...(older_than_days !== undefined ? { older_than_days } : {}) }, reason },
    },
    'high'
  ),
  // verticals (Grok Bot operator layer) ----------------------------------------
  tiered(
    {
      name: 'list_verticals',
      description:
        'List the verticals (lines of business, one Grok Bot each): id, name, scopes, campaign_ids, is_default; archived ones with include_archived.',
      inputSchema: z.object({ include_archived: z.boolean().optional() }),
      run: async ({ include_archived }, { call }) => (await call(`/api/verticals${include_archived ? '?archived=1' : ''}`)) as ToolResult,
    },
    'read'
  ),
  tiered(
    {
      name: 'create_vertical',
      description:
        'Create a vertical (a line of business a Grok Bot will run): name, scopes (which unrouted items it owns: campaign, orders, replies, validation) and the campaign ids it owns (Instantly ids, or gmail:/muse: ids). Created with no operator key; offer issue_operator_key next.',
      inputSchema: z.object({
        name: z.string().trim().min(1).max(80),
        scopes: z.array(z.enum(['campaign', 'orders', 'replies', 'validation'])).max(4).optional(),
        campaign_ids: z.array(campaignId).max(50).optional(),
      }),
      run: async (input, { call }) => (await call('/api/verticals', { method: 'POST', body: input })) as ToolResult,
    },
    'low'
  ),
  tiered(
    {
      name: 'update_vertical',
      description:
        'Change a vertical: rename it, replace its scopes or campaign_ids (the full new list), or archive it (archive: true, alone). Archiving does not revoke its bot keys; the owner revokes keys in Settings.',
      inputSchema: z
        .object({
          vertical_id: uuid,
          name: z.string().trim().min(1).max(80).optional(),
          scopes: z.array(z.enum(['campaign', 'orders', 'replies', 'validation'])).max(4).optional(),
          campaign_ids: z.array(campaignId).max(50).optional(),
          archive: z.literal(true).optional(),
        })
        .refine((v) => (v.archive ? v.name === undefined && v.scopes === undefined && v.campaign_ids === undefined : v.name !== undefined || v.scopes !== undefined || v.campaign_ids !== undefined), 'archive alone, or at least one change'),
      run: async ({ vertical_id, archive, ...patch }, { call }) =>
        (await call(`/api/verticals/${vertical_id.toLowerCase()}`, { method: 'PATCH', body: archive ? { archived: true } : patch })) as ToolResult,
    },
    'low'
  ),
  tiered(
    {
      name: 'issue_operator_key',
      description:
        "Issue a Grok Bot operator key for one vertical (never a master key: only the owner mints those in Settings). The key is a sign-in link with the owner's full rights. Once approved, the sign-in link appears ONCE (on the approval card, or in this tool's result in skip mode); Lume stores only a masked copy, so pass it on immediately and never repeat it later.",
      inputSchema: z.object({ vertical_id: uuid, label: z.string().trim().min(1).max(80).optional() }),
      payload: ({ vertical_id, label }) => ({ vertical_id: vertical_id.toLowerCase(), ...(label ? { label } : {}) }),
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

/** Only the owner or the master Grok Bot may create / change verticals or issue keys. */
export const MASTER_ONLY_TOOLS: ReadonlySet<string> = new Set(['create_vertical', 'update_vertical', 'issue_operator_key'])

export function buildTools(deps: ToolDeps): AgentTool[] {
  const call = routeCaller(deps)
  const vertBot = !!deps.operator && !deps.operator.is_master
  return SPECS.map((build) => build(deps, call)).filter((t) => !(vertBot && MASTER_ONLY_TOOLS.has(t.name)))
}
