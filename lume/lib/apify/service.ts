import 'server-only'
import { createHash } from 'node:crypto'
import {
  ApifyError,
  getActor,
  getActorInputSchema,
  planTier,
  searchStore,
  type ActorDetails,
  type StoreActor,
} from '@/lib/adapters/apify'
import { describeInput, parseInputSchema, summarizeSchema, validateActorInput, type InputField, type InputSchema } from '@/lib/apify/input'
import {
  ACTOR_RUN_CAP_USD,
  currentPricingInfo,
  describePrice,
  parsePricing,
  planRun,
  type Pricing,
  type RunOptions,
  type RunPlan,
} from '@/lib/apify/pricing'
import type { Json } from '@/lib/db/types'

/**
 * The Apify half of the agent's campaign flow: Store shortlist, the brief the
 * agent shows before asking for inputs, and the `run_actor` snapshot
 * (validated input + capped run options) the owner confirms.
 */

export const ACTOR_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}[/~][A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

export interface ShortlistItem {
  id: string
  title: string
  description: string
  rating: number | null
  reviews: number | null
  users: number | null
  users_30d: number | null
  success_rate_30d: number | null
  pricing_model: string
  price: string
  /** Lume can cap a run of it at the $20 limit. */
  runnable: boolean
  not_runnable_reason?: string
  url: string
}

function shortlistItem(a: StoreActor, tier: string | null): ShortlistItem {
  const pricing = parsePricing(a.pricingInfo, tier)
  const plan = planRun(pricing)
  return {
    id: a.id,
    title: a.title,
    description: a.description,
    rating: a.rating !== null ? Math.round(a.rating * 100) / 100 : null,
    reviews: a.reviews,
    users: a.users,
    users_30d: a.users30d,
    success_rate_30d: a.successRate30d,
    pricing_model: pricing.model,
    price: describePrice(pricing),
    runnable: plan.ok,
    ...(plan.ok ? {} : { not_runnable_reason: plan.reason }),
    url: a.url,
  }
}

/** Ranking: runnable first, then rating × reach × reliability. */
export function rankScore(x: ShortlistItem): number {
  const rating = x.rating ?? 3.5
  const reach = Math.log10((x.users_30d ?? 0) + 10)
  const reliability = (x.success_rate_30d ?? 90) / 100
  return (x.runnable ? 1000 : 0) + rating * reach * reliability
}

export async function storeShortlist(query: string, limit = 8): Promise<{ total: number; actors: ShortlistItem[] }> {
  const [found, tier] = await Promise.all([searchStore(query, Math.min(limit * 2, 30)), planTier()])
  const actors = found.items
    .map((a) => shortlistItem(a, tier))
    .sort((a, b) => rankScore(b) - rankScore(a))
    .slice(0, limit)
  return { total: found.total, actors }
}

export interface ActorBrief {
  actor: ActorDetails
  pricing: Pricing
  schema: InputSchema | null
  minMemoryMb: number | null
}

export async function loadActor(actorId: string): Promise<ActorBrief> {
  const [actor, build, tier] = await Promise.all([getActor(actorId), getActorInputSchema(actorId), planTier()])
  return {
    actor,
    pricing: parsePricing(currentPricingInfo(actor.pricingInfos), tier),
    schema: parseInputSchema(build.schema),
    minMemoryMb: build.minMemoryMb,
  }
}

/** What `get_actor_input_schema` returns: everything the agent needs to ask the owner. */
export function briefView(b: ActorBrief): Record<string, unknown> {
  const plan = planRun(b.pricing, { defaultMemoryMb: b.actor.defaultMemoryMb, minMemoryMb: b.minMemoryMb })
  const fields: InputField[] = b.schema ? summarizeSchema(b.schema) : []
  return {
    actor: { id: b.actor.name, title: b.actor.title, description: b.actor.description, url: `https://apify.com/${b.actor.name}` },
    deprecated: b.actor.isDeprecated,
    pricing: {
      model: b.pricing.model,
      price: describePrice(b.pricing),
      cap_usd: ACTOR_RUN_CAP_USD,
      runnable: plan.ok,
      ...(plan.ok ? {} : { not_runnable_reason: plan.reason }),
      minimal_budget_usd: b.pricing.minimalMaxTotalChargeUsd,
    },
    required: b.schema?.required ?? [],
    fields,
    total_fields: b.schema ? Object.keys(b.schema.properties).length : 0,
    note:
      'Ask the owner for every required field and confirm the important ones before proposing a run. ' +
      '`default` values apply automatically when a field is left out; `prefill` values do NOT — include them explicitly if the owner wants them. ' +
      'Fields marked costsExtra add per-result charges.',
  }
}

export interface RunActorRequest {
  actor_id: string
  input: Record<string, unknown>
  max_charge_usd?: number
  expected_items?: number
}

/** Stable JSON (sorted keys) for the dedupe hash. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

export function runInputHash(actorId: string, input: Record<string, unknown>, budgetUsd: number): string {
  return createHash('sha256')
    .update(stable({ a: actorId.replace('~', '/').toLowerCase(), i: input, b: budgetUsd }))
    .digest('hex')
    .slice(0, 32)
}

export type RunActorCheck =
  | { ok: true; brief: ActorBrief; plan: Extract<RunPlan, { ok: true }> }
  | { ok: false; status: number; error: string }

/** Load the actor, validate the input against its schema, plan the capped run. */
export async function checkRunActor(req: RunActorRequest): Promise<RunActorCheck> {
  let brief: ActorBrief
  try {
    brief = await loadActor(req.actor_id)
  } catch (err) {
    if (err instanceof ApifyError && err.code === 'not_found') return { ok: false, status: 404, error: 'actor_not_found' }
    if (err instanceof ApifyError && err.code === 'not_configured') return { ok: false, status: 503, error: 'apify_not_configured' }
    throw err
  }
  if (brief.actor.isDeprecated) return { ok: false, status: 409, error: 'actor_deprecated' }
  if (!brief.schema) return { ok: false, status: 422, error: 'actor_has_no_input_schema' }
  const errors = validateActorInput(brief.schema, req.input, { noResidentialProxy: true })
  if (errors.length) return { ok: false, status: 400, error: `invalid_input: ${errors.join('; ')}` }
  const plan = planRun(brief.pricing, {
    maxChargeUsd: req.max_charge_usd,
    expectedItems: req.expected_items,
    defaultMemoryMb: brief.actor.defaultMemoryMb,
    minMemoryMb: brief.minMemoryMb,
  })
  if (!plan.ok) return { ok: false, status: 409, error: `not_runnable: ${plan.reason}` }
  return { ok: true, brief, plan }
}

const money = (n: number) => `$${n.toFixed(2)}`

/** The `run_actor` snapshot the owner confirms (and the executor re-checks). */
export function runActorPayload(req: RunActorRequest, brief: ActorBrief, plan: Extract<RunPlan, { ok: true }>) {
  const actorId = brief.actor.name
  const payload: Record<string, Json> & { summary: string } = {
    actor_id: actorId,
    actor_title: brief.actor.title,
    pricing_model: plan.model,
    input: req.input as Json,
    options: plan.options as unknown as Json,
    budget_usd: plan.budgetUsd,
    cap_usd: ACTOR_RUN_CAP_USD,
    estimate_usd: plan.estimateUsd,
    estimate_note: plan.estimateNote,
    input_hash: runInputHash(actorId, req.input, plan.budgetUsd),
    summary:
      `Run Apify actor ${brief.actor.title} (${actorId}) — est. ${money(plan.estimateUsd)}, hard cap ${money(plan.budgetUsd)}\n` +
      describeInput(req.input),
  }
  if (req.expected_items) payload.expected_items = Math.floor(req.expected_items)
  return payload
}

/**
 * Executor-side: the options to start with, never looser than what the owner
 * confirmed. Same pricing model required; a lower price per result keeps the
 * confirmed `maxItems`, a higher one shrinks it.
 */
export function tightenOptions(confirmed: RunOptions, model: string, now: Extract<RunPlan, { ok: true }>): RunOptions | string {
  if (now.model !== model) return `pricing changed since confirmation (${model} → ${now.model})`
  const out: RunOptions = {
    timeout: Math.min(confirmed.timeout, now.options.timeout),
    maxTotalChargeUsd: Math.min(confirmed.maxTotalChargeUsd, now.options.maxTotalChargeUsd),
  }
  const mem = [confirmed.memory, now.options.memory].filter((x): x is number => typeof x === 'number')
  if (mem.length) out.memory = Math.min(...mem)
  const items = [confirmed.maxItems, now.options.maxItems].filter((x): x is number => typeof x === 'number')
  if (items.length) out.maxItems = Math.min(...items)
  return out
}
