import { createHash } from 'node:crypto'
import { z } from 'zod'
import { buildActionRequest } from '@/lib/actions/build'
import { createAction, DuplicateActionError, InvalidActionPayloadError } from '@/lib/actions/create'
import { dispatchExecuteNow } from '@/lib/actions/execute'
import { MCP_CONFIRM_CEILING, McpKindNotAllowedError } from '@/lib/actions/mcpPolicy'
import { claimDecision, getAction } from '@/lib/actions/store'
import { getSequenceFresh } from '@/lib/adapters/instantlySequences'
import { editMessage } from '@/lib/adapters/telegram'
import { campaignStatusLabel } from '@/lib/adapters/instantly.map'
import { getCampaignSuggestion } from '@/lib/campaigns/suggestData'
import { editStepsSchema, toEditSteps } from '@/lib/campaigns/sequence'
import type { Json, PendingActionKind, PendingActionRow } from '@/lib/db/types'
import { mcpOrigin } from '../context'
import { idempotencyKey } from '../idempotency'
import { McpUserError, truncate } from '../sanitize'
import { defineTool, READ_ONLY, type ToolDef } from '../tool'

/**
 * Group C: gated actions. A gated tool never acts. It builds the action the
 * same way the dashboard does (buildActionRequest: live counts, diffs, SOP
 * gate, summaries), files it as a `pending_actions` row with
 * requested_by = 'mcp', and returns the preview. The owner approves it in the
 * Lume dashboard or Telegram, which runs the usual executor.
 *
 * lume_confirm_action lets MCP approve its own row only when all hold:
 *   - the kind is in LUME_MCP_CONFIRM_KINDS ∩ MCP_CONFIRM_CEILING (pause only;
 *     resume restarts sending, so it always needs the owner),
 *   - the row was requested by MCP, is still awaiting, and is under 1 hour old,
 *   - the preview hash still matches the live facts (campaign status).
 * The approval then hands off to /api/actions/<id>/execute, like Telegram.
 */

export const CONFIRM_WINDOW_MS = 60 * 60_000
/** Mirrors lib/rules/tick.ts ACTION_TTL_MS: awaiting rows expire after 24 h. */
const EXPIRES_AFTER_MS = 24 * 60 * 60_000
const DEFAULT_CONFIRM_KINDS = 'pause_campaign'

/** Runtime allowlist (config), narrowed to the code ceiling: config can only remove kinds. */
export function confirmableKinds(env: Record<string, string | undefined> = process.env): Set<PendingActionKind> {
  const raw = env.LUME_MCP_CONFIRM_KINDS ?? DEFAULT_CONFIRM_KINDS
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((k): k is PendingActionKind => MCP_CONFIRM_CEILING.has(k as PendingActionKind)),
  )
}

/** Request tools: they file a row, nothing else. */
const GATED_REQUEST = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const
/** lume_confirm_action: approving starts a real change in Instantly. */
const GATED_CONFIRM = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const
const READ_LIVE = { ...READ_ONLY, openWorldHint: true } as const

const uuid = z.uuid()
const campaignId = z.string().trim().min(1).max(200).describe('Instantly campaign id (lume_list_campaigns → external_id).')

// ---------------------------------------------------------------------------
// Shared: file one action and describe it

/** Scalars as-is (strings clipped), arrays as counts, objects skipped: the dashboard's detail rows. */
export function previewDetails(payload: Record<string, Json>): Record<string, Json> {
  const out: Record<string, Json> = {}
  for (const [k, v] of Object.entries(payload)) {
    if (k === 'summary' || v === null || v === undefined) continue
    if (Array.isArray(v)) out[`${k}_count`] = v.length
    else if (typeof v === 'string') out[k] = truncate(v, 300)
    else if (typeof v !== 'object') out[k] = v
  }
  return out
}

/** Facts a pause confirm re-checks: the row and the campaign's live status. */
export function previewHash(row: Pick<PendingActionRow, 'id' | 'kind' | 'payload'>, liveStatus: number | null): string {
  const facts = { id: row.id, kind: row.kind, campaign_id: String(row.payload?.campaign_id ?? ''), status: liveStatus }
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex')
}

function buildRefusal(b: { status: number; error: string; problems?: string[] }): McpUserError {
  const extra = b.problems?.length ? `: ${b.problems.slice(0, 5).join('; ')}` : ''
  return new McpUserError(`Lume refused this request (${b.error})${extra}. Nothing was filed.`)
}

type Filed = { row: PendingActionRow; payload: Record<string, Json> & { summary: string } }

/** buildActionRequest → createAction(..., 'mcp'). Throws McpUserError for every refusal; files nothing on refusal. */
export async function fileAction(kind: PendingActionKind, payload: Record<string, unknown>): Promise<Filed> {
  const built = await buildActionRequest({ kind, payload })
  if (!built.ok) throw buildRefusal(built)
  try {
    const row = await createAction(built.kind, built.payload, 'mcp', { ruleId: built.ruleId ?? null })
    return { row, payload: built.payload }
  } catch (err) {
    if (err instanceof DuplicateActionError) {
      throw new McpUserError(`An awaiting ${kind} for this target already exists (action ${err.existingId}). Approve, reject or cancel it first.`)
    }
    if (err instanceof InvalidActionPayloadError) throw new McpUserError(`Lume refused the payload (${err.message}). Nothing was filed.`)
    if (err instanceof McpKindNotAllowedError) throw new McpUserError(`MCP may not file ${kind}.`)
    throw err
  }
}

function describe(filed: Filed, extra: Record<string, unknown> = {}) {
  const { row, payload } = filed
  const created = Date.parse(row.created_at ?? '') || Date.now()
  return {
    action_id: row.id,
    kind: row.kind,
    status: row.status,
    summary: payload.summary,
    details: previewDetails(payload),
    approve_in: `Lume dashboard (/actions/${row.id}) or the Telegram prompt`,
    expires_at: new Date(created + EXPIRES_AFTER_MS).toISOString(),
    ...extra,
  }
}

function gatedTool<S extends z.ZodObject>(def: {
  name: `lume_${string}`
  title: string
  description: string
  input: S
  kind: PendingActionKind
  toPayload: (args: z.infer<S>) => Record<string, unknown>
}): ToolDef {
  return defineTool({
    name: def.name,
    title: def.title,
    description: `${def.description} Files a pending action for the owner to approve in the Lume dashboard or Telegram and returns its preview; it does not act. An identical request already awaiting is refused.`,
    cls: 'write',
    input: def.input,
    annotations: GATED_REQUEST,
    run: async (args) => {
      const filed = await fileAction(def.kind, def.toPayload(args))
      return { data: describe(filed), refs: { action_id: filed.row.id, kind: def.kind } }
    },
  }) as unknown as ToolDef
}

// ---------------------------------------------------------------------------
// Campaign setup first

export const suggestCampaignSetup = defineTool({
  name: 'lume_suggest_campaign_setup',
  title: 'Suggest a new campaign setup',
  description:
    "Read-only. For a validation job or a lead list (or neither, for defaults): profiles the leads and suggests the tag, template, campaign name, inboxes, schedule and daily limit for a NEW campaign, with the template and inbox options. Use its answer as the input to lume_create_campaign. Calls Instantly to read inboxes and campaigns.",
  cls: 'read',
  input: z.object({ job_id: uuid.optional(), list_id: uuid.optional() }),
  annotations: READ_LIVE,
  run: async ({ job_id, list_id }) => {
    if (job_id && list_id) throw new McpUserError('Pass job_id or list_id, not both.')
    const out = await getCampaignSuggestion(job_id ? { job_id: job_id.toLowerCase() } : list_id ? { list_id: list_id.toLowerCase() } : null, { withSources: false })
    if (!out) throw new McpUserError('No job or list with that id.')
    const o = out as unknown as Record<string, unknown>
    const opts = (o.options ?? {}) as { templates?: { id: string; name: string; why?: string }[]; accounts?: { email: string }[] }
    return {
      data: {
        suggestion: o.suggestion ?? null,
        tags: Array.isArray(o.verticals) ? (o.verticals as { id: string; name: string; score: number; why: string }[]).slice(0, 4) : [],
        templates: (opts.templates ?? []).map((t) => ({ id: t.id, name: t.name, why: t.why })),
        inboxes: (opts.accounts ?? []).map((a) => a.email),
      },
    }
  },
}) as unknown as ToolDef

export const getCampaignSequence = defineTool({
  name: 'lume_get_campaign_sequence',
  title: 'Read a campaign sequence',
  description:
    "Read-only. An Instantly campaign's live email sequence in the editable shape (steps → variants with subject/body) plus its hash. Pass that hash as base_hash to lume_update_sequence so an edit made in between is caught. Calls Instantly.",
  cls: 'read',
  input: z.object({ campaign_id: campaignId }),
  annotations: READ_LIVE,
  run: async ({ campaign_id }) => {
    const seq = await getSequenceFresh(campaign_id)
    return {
      data: {
        campaign_id,
        name: seq.name,
        status: seq.status === null ? null : campaignStatusLabel(seq.status),
        base_hash: seq.hash,
        // Copy written by the owner; still shown as data, not instructions.
        steps: { untrusted: JSON.stringify(toEditSteps(seq.steps)) },
      },
    }
  },
}) as unknown as ToolDef

export const createCampaign = gatedTool({
  name: 'lume_create_campaign',
  title: 'Request a new campaign',
  description:
    'Requests a NEW Instantly campaign from a template (kind new_campaign): name, template, inboxes, daily limit, optional tag, schedule, and the validation job or lead list it is for. Lume checks the inboxes exist and the name is free. Once approved it is created as a draft (never activated) and tagged.',
  kind: 'new_campaign',
  input: z.object({
    name: z.string().trim().min(1).max(200),
    template_id: uuid.describe('From lume_suggest_campaign_setup.'),
    email_list: z.array(z.email().max(320)).min(1).max(200).describe('Sending inboxes, from lume_suggest_campaign_setup.'),
    daily_limit: z.number().int().min(1).max(10_000),
    vertical_id: uuid.optional().describe('Tag (vertical) id.'),
    campaign_schedule: z.record(z.string(), z.unknown()).optional().describe('As suggested; omit for the default.'),
    job_id: uuid.optional(),
    list_id: uuid.optional(),
    no_location_sibling: z.boolean().optional(),
    idempotency_key: idempotencyKey,
  }),
  toPayload: ({ idempotency_key: _k, ...a }) => (void _k, { ...a, template_id: a.template_id.toLowerCase() }),
})

export const duplicateCampaign = gatedTool({
  name: 'lume_duplicate_campaign',
  title: 'Request a campaign copy',
  description:
    'Requests a copy of an existing Instantly campaign under a new name (kind create_campaign). Note: the copy takes the source campaign as it is when approved (inboxes, schedule, sequence), not as it is now. Created as a draft.',
  kind: 'create_campaign',
  input: z.object({ source_campaign_id: campaignId, name: z.string().trim().min(1).max(200), idempotency_key: idempotencyKey }),
  toPayload: ({ source_campaign_id, name }) => ({ source_campaign_id, name }),
})

export const updateSequence = gatedTool({
  name: 'lume_update_sequence',
  title: 'Request a sequence edit',
  description:
    "Requests replacing a campaign's email sequence with `steps` (kind update_sequence). base_hash from lume_get_campaign_sequence is required: if the live sequence changed since, Lume refuses. Lume diffs before/after and runs the SOP lint; blocking problems are refused. The executor re-checks the hash before writing.",
  kind: 'update_sequence',
  input: z.object({
    campaign_id: campaignId,
    base_hash: z.string().regex(/^[0-9a-f]{32}$/).describe('From lume_get_campaign_sequence.'),
    steps: editStepsSchema,
    idempotency_key: idempotencyKey,
  }),
  toPayload: ({ campaign_id, base_hash, steps }) => ({ campaign_id, base_hash, steps }),
})

export const pushToInstantly = gatedTool({
  name: 'lume_push_to_instantly',
  title: 'Request an Instantly push',
  description:
    "Requests pushing a validation job's leads into its Instantly campaign (kind push_to_instantly). This is outreach: approved leads enter live sequences. Lume previews the eligible count (and whether they go to the lead bank first); nothing eligible is refused. The job must be in review.",
  kind: 'push_to_instantly',
  input: z.object({ job_id: uuid.describe('Validation job id (lume_list_validation_jobs).'), idempotency_key: idempotencyKey }),
  toPayload: ({ job_id }) => ({ job_id: job_id.toLowerCase() }),
})

export const runValidation = gatedTool({
  name: 'lume_run_validation',
  title: 'Request validation of a lead list',
  description:
    'Requests sending a lead list to email validation (kind send_lead_list). May spend validator credits after the ingest approval. Lists with no emails or already sent are refused.',
  kind: 'send_lead_list',
  input: z.object({ list_id: uuid.describe('Lead list id.'), idempotency_key: idempotencyKey }),
  toPayload: ({ list_id }) => ({ list_id: list_id.toLowerCase() }),
})

// ---------------------------------------------------------------------------
// The rest

/** Instantly status codes (instantly.map.ts): 0 draft, 1 active, 2 paused, 3 completed, 4 running subsequences. */
const PAUSABLE = new Set([1, 4])
const RESUMABLE = new Set([2])

function pauseResume(kind: 'pause_campaign' | 'resume_campaign'): ToolDef {
  const pausing = kind === 'pause_campaign'
  return defineTool({
    name: pausing ? 'lume_pause_campaign' : 'lume_resume_campaign',
    title: pausing ? 'Request a campaign pause' : 'Request a campaign resume',
    description: `${pausing ? 'Requests pausing an active Instantly campaign' : 'Requests resuming a paused Instantly campaign (never a draft: that would launch it)'} (kind ${kind}). Reads the live status first and refuses if it is already ${pausing ? 'paused or not running' : 'running or not paused'}. ${pausing ? 'Returns a preview_hash: the owner can approve in Lume or Telegram, or, within 1 hour, lume_confirm_action can approve it.' : 'Only the owner can approve a resume (Lume or Telegram); lume_confirm_action refuses it.'}`,
    cls: 'write',
    input: z.object({ campaign_id: campaignId, idempotency_key: idempotencyKey }),
    annotations: GATED_REQUEST,
    run: async ({ campaign_id }) => {
      const live = await getSequenceFresh(campaign_id)
      const ok = live.status !== null && (pausing ? PAUSABLE : RESUMABLE).has(live.status)
      if (!ok) {
        const label = live.status === null ? 'unknown' : campaignStatusLabel(live.status)
        throw new McpUserError(`The campaign is ${label}; ${pausing ? 'only an active campaign can be paused' : 'only a paused campaign can be resumed'}. Nothing was filed.`)
      }
      const filed = await fileAction(kind, { campaign_id })
      const created = Date.parse(filed.row.created_at ?? '') || Date.now()
      const confirmable = confirmableKinds().has(kind)
      return {
        data: describe(filed, {
          live_status: campaignStatusLabel(live.status!),
          mcp_can_confirm: confirmable,
          ...(confirmable ? { preview_hash: previewHash(filed.row, live.status), confirm_by: new Date(created + CONFIRM_WINDOW_MS).toISOString() } : {}),
        }),
        refs: { action_id: filed.row.id, kind },
      }
    },
  }) as unknown as ToolDef
}

export const pauseCampaign = pauseResume('pause_campaign')
export const resumeCampaign = pauseResume('resume_campaign')

export const assignLeads = gatedTool({
  name: 'lume_assign_leads',
  title: 'Request a lead assignment',
  description:
    'Requests queueing lead-bank leads that match a filter for a campaign (kind assign_leads); rotation then moves them into Instantly as slots free. Lume counts the matches for the preview.',
  kind: 'assign_leads',
  input: z.object({
    campaign_id: campaignId,
    filter: z.record(z.string(), z.unknown()).describe('A rule filter (same shape as rotation rules).'),
    limit: z.number().int().min(1).max(100_000).optional(),
    idempotency_key: idempotencyKey,
  }),
  toPayload: ({ campaign_id, filter, limit }) => ({ campaign_id, filter, ...(limit ? { limit } : {}) }),
})

const POST_URL = z.string().trim().min(1).max(500)

/**
 * post_url / post_urls as one deduped list. Accepts what a client with a stale
 * tool list sends too: post_urls as a JSON-array string or a comma/space/newline
 * separated string. URL shape and the 1-10 limit are checked by the builder.
 */
export function targetPostUrls(post_url?: string, post_urls?: string[] | string): string[] | undefined {
  const list: string[] = []
  if (post_url) list.push(post_url.trim())
  if (Array.isArray(post_urls)) list.push(...post_urls.map((u) => u.trim()))
  else if (typeof post_urls === 'string') {
    const raw = post_urls.trim()
    let parsed: unknown = null
    if (raw.startsWith('[')) {
      try {
        parsed = JSON.parse(raw)
      } catch {
        parsed = null
      }
    }
    if (Array.isArray(parsed)) list.push(...parsed.filter((u): u is string => typeof u === 'string').map((u) => u.trim()))
    else list.push(...raw.split(/[\s,]+/))
  }
  const out = [...new Set(list.filter(Boolean))]
  return out.length ? out : undefined
}

export const runInfluencerScrape = gatedTool({
  name: 'lume_run_influencer_scrape',
  title: 'Request an influencer scrape',
  description:
    "Requests scraping tracked influencers' recent posts and reactors (kind influencer_run). Spends Apify credit; the preview shows the estimate and what is left of the monthly cap. " +
    'To run on specific posts only, pass post_url (one LinkedIn post URL) or post_urls (1-10), all by the ONE influencer in slugs: no posts scrape, and the run goes straight to the reactions bill, priced at the per-post cap.',
  kind: 'influencer_run',
  input: z.object({
    slugs: z.array(z.string().trim().min(1).max(80)).min(1).max(100).describe('Influencer slugs (lume_list_influencers).'),
    max_verify_usd: z.number().min(0).max(1000).optional(),
    post_url: POST_URL.optional().describe('Optional: one LinkedIn post URL (linkedin.com/posts/... or feed/update/urn:li:activity:...) by the influencer in slugs. Single-post run.'),
    post_urls: z
      .union([z.array(POST_URL).min(1).max(10), z.string().trim().min(1).max(5000)])
      .optional()
      .describe('Optional: 1-10 LinkedIn post URLs by the one influencer in slugs (an array; a comma-separated string also works).'),
    idempotency_key: idempotencyKey,
  }),
  toPayload: ({ slugs, max_verify_usd, post_url, post_urls }) => {
    const targets = targetPostUrls(post_url, post_urls)
    return {
      slugs,
      ...(max_verify_usd !== undefined ? { max_verify_usd } : {}),
      ...(targets ? { post_urls: targets } : {}),
    }
  },
})

export const runInfluencerReactions = gatedTool({
  name: 'lume_run_influencer_reactions',
  title: 'Request reaction verification',
  description: 'Requests verifying the reactors of a finished influencer run (kind influencer_reactions). Spends Apify credit; the preview shows the exact bill.',
  kind: 'influencer_reactions',
  input: z.object({ run_id: uuid, max_verify_usd: z.number().min(0).max(1000).optional(), idempotency_key: idempotencyKey }),
  toPayload: ({ run_id, max_verify_usd }) => ({ run_id: run_id.toLowerCase(), ...(max_verify_usd !== undefined ? { max_verify_usd } : {}) }),
})

export const runInfluencerLookup = gatedTool({
  name: 'lume_run_influencer_lookup',
  title: 'Request an influencer candidate lookup',
  description: 'Requests looking up a staged batch of influencer candidates (kind influencer_lookup). Spends Apify credit per person; the preview shows the estimate and cap.',
  kind: 'influencer_lookup',
  input: z.object({ batch_id: uuid, max_usd: z.number().min(0).max(50).optional(), idempotency_key: idempotencyKey }),
  toPayload: ({ batch_id, max_usd }) => ({ batch_id: batch_id.toLowerCase(), ...(max_usd !== undefined ? { max_usd } : {}) }),
})

// ---------------------------------------------------------------------------
// Confirm / cancel

async function markTelegram(row: PendingActionRow, text: string): Promise<void> {
  if (!row.telegram_message_id) return
  try {
    await editMessage(row.telegram_message_id, text)
  } catch (err) {
    console.error('[mcp] telegram edit failed:', err instanceof Error ? err.message : 'unknown')
  }
}

export const confirmAction = defineTool({
  name: 'lume_confirm_action',
  title: 'Confirm an MCP-requested action',
  description:
    'Approves a pending action this MCP server requested, and starts it. Only pause_campaign (resume and everything else need the owner in Lume or Telegram), only within 1 hour of the request, and only if preview_hash still matches the live campaign status; otherwise it refuses and the owner approves in Lume or Telegram. Starting it changes the live Instantly campaign.',
  cls: 'confirm',
  input: z.object({
    action_id: uuid,
    preview_hash: z.string().regex(/^[0-9a-f]{64}$/).describe('From the request tool’s preview.'),
    confirm: z.literal(true).describe('Must be true.'),
  }),
  annotations: GATED_CONFIRM,
  run: async ({ action_id, preview_hash }) => {
    const id = action_id.toLowerCase()
    const row = await getAction(id)
    if (!row) throw new McpUserError('No action with that id.')
    if (row.requested_by !== 'mcp') throw new McpUserError('Only actions requested through MCP can be confirmed here. Approve it in Lume or Telegram.')
    if (!confirmableKinds().has(row.kind)) throw new McpUserError(`${row.kind} is not confirmable through MCP. Approve it in Lume or Telegram.`)
    if (row.status !== 'awaiting' || row.claim_status !== 'awaiting') throw new McpUserError(`The action is already ${row.status}. Nothing was done.`)
    const age = Date.now() - Date.parse(row.created_at)
    if (!(age >= 0 && age <= CONFIRM_WINDOW_MS)) {
      throw new McpUserError('The action is older than 1 hour, so MCP can no longer confirm it. Approve it in Lume or Telegram (it stays open there until it expires at 24 h), or cancel and request it again.')
    }
    const live = await getSequenceFresh(String(row.payload?.campaign_id ?? ''))
    if (previewHash(row, live.status) !== preview_hash) {
      const now = live.status === null ? 'unknown' : campaignStatusLabel(live.status)
      throw new McpUserError(`The campaign changed since the preview (status now ${now}). Nothing was done. Cancel this action and request a new one.`)
    }
    const claimed = await claimDecision(id, true, 'mcp')
    if (!claimed) throw new McpUserError('Someone decided this action first (dashboard or Telegram). Nothing was done here.')
    await markTelegram(claimed, `✅ Approved — ${claimed.kind} (from MCP)`)
    const origin = mcpOrigin() ?? process.env.LUME_INTERNAL_URL ?? null
    const sent = origin ? await dispatchExecuteNow(id, origin) : { error: 'no origin' }
    return {
      data: {
        action_id: id,
        kind: claimed.kind,
        status: 'approved',
        started: sent === 'dispatched',
        note:
          sent === 'dispatched'
            ? 'Running now. Check with lume_get_action.'
            : 'Approved; the start request did not go through, so the 15-minute sweeper will start it (at most 4 re-sends, then it is marked not run).',
      },
      refs: { action_id: id, kind: claimed.kind },
    }
  },
}) as unknown as ToolDef

export const cancelAction = defineTool({
  name: 'lume_cancel_action',
  title: 'Cancel an MCP-requested action',
  description: 'Rejects a still-awaiting pending action that this MCP server requested (recorded as decided via MCP). It never touches actions requested from the dashboard, Telegram, rules or the agent.',
  cls: 'write',
  input: z.object({ action_id: uuid, idempotency_key: idempotencyKey }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  run: async ({ action_id }) => {
    const id = action_id.toLowerCase()
    const row = await getAction(id)
    if (!row) throw new McpUserError('No action with that id.')
    if (row.requested_by !== 'mcp') throw new McpUserError('Only actions requested through MCP can be cancelled here.')
    if (row.status !== 'awaiting') return { data: { action_id: id, cancelled: false, status: row.status } }
    const claimed = await claimDecision(id, false, 'mcp')
    if (!claimed) throw new McpUserError('Someone decided this action first. Nothing was changed.')
    await markTelegram(claimed, `❌ Cancelled — ${claimed.kind} (from MCP)`)
    return { data: { action_id: id, cancelled: true, status: 'rejected' }, refs: { action_id: id, kind: claimed.kind } }
  },
}) as unknown as ToolDef

/** Campaign setup first, then the rest, then confirm/cancel. */
export const gatedTools: ToolDef[] = [
  suggestCampaignSetup,
  getCampaignSequence,
  createCampaign,
  duplicateCampaign,
  updateSequence,
  pushToInstantly,
  runValidation,
  pauseCampaign,
  resumeCampaign,
  assignLeads,
  runInfluencerScrape,
  runInfluencerReactions,
  runInfluencerLookup,
  confirmAction,
  cancelAction,
]
