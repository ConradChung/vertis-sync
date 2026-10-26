/**
 * Apify pricing → run limits, pure. Every actor run Lume starts is capped at
 * `ACTOR_RUN_CAP_USD`, enforced by Apify itself through the run options:
 *
 *  - PAY_PER_EVENT:          `maxTotalChargeUsd` = the budget (Apify stops
 *                            charging events past it). Refused when the
 *                            actor's own `minimalMaxTotalChargeUsd` is above it.
 *  - PRICE_PER_DATASET_ITEM: `maxItems` = floor(budget / price per item) (only
 *                            that many results are charged) + `maxTotalChargeUsd`.
 *  - FREE (pay per usage):   the cost is platform compute, so memory and
 *                            timeout are capped so memory GB × hours ×
 *                            `CU_USD_MAX` stays inside the budget.
 *                            Residential proxy traffic is billed per GB and
 *                            can't be capped, so inputs asking for it are
 *                            refused (lib/apify/input.ts).
 *  - FLAT_PRICE_PER_MONTH (rental) or anything unknown: refused — a monthly
 *    fee can't be bounded per run.
 *
 * Every run also gets a timeout (no 7-day defaults), so nothing runs open-ended.
 */

export const ACTOR_RUN_CAP_USD = 20
/** Worst-case compute unit price (Apify's highest list price). */
export const CU_USD_MAX = 0.4
/** Memory ceiling for pay-per-usage runs. */
export const USAGE_MEMORY_MAX_MB = 4096
export const DEFAULT_TIMEOUT_SECS = 3600
export const MAX_TIMEOUT_SECS = 7200

export type PricingModel = 'FREE' | 'PAY_PER_EVENT' | 'PRICE_PER_DATASET_ITEM' | 'FLAT_PRICE_PER_MONTH'

export interface PricingEvent {
  name: string
  title: string
  priceUsd: number
  primary: boolean
  /** Charged once per run (actor start). */
  oneTime: boolean
}

export interface Pricing {
  model: PricingModel | string
  /** PRICE_PER_DATASET_ITEM and FLAT_PRICE_PER_MONTH. */
  pricePerUnitUsd: number | null
  events: PricingEvent[]
  minimalMaxTotalChargeUsd: number | null
}

type Raw = Record<string, unknown>
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
const obj = (v: unknown): Raw | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null)

/**
 * The price of one event: the flat `eventPriceUsd`, else the plan tier's
 * price, else the highest tier (conservative).
 */
function eventPrice(e: Raw, tier?: string | null): number | null {
  const flat = num(e.eventPriceUsd)
  if (flat !== null) return flat
  const tiers = obj(e.eventTieredPricingUsd)
  if (!tiers) return null
  const pick = tier ? num(obj(tiers[tier])?.tieredEventPriceUsd) : null
  if (pick !== null) return pick
  const all = Object.values(tiers)
    .map((t) => num(obj(t)?.tieredEventPriceUsd))
    .filter((x): x is number => x !== null)
  return all.length ? Math.max(...all) : null
}

/** One `pricingInfo` object (store item `currentPricingInfo`, or an entry of actor `pricingInfos`). */
export function parsePricing(info: unknown, tier?: string | null): Pricing {
  const p = obj(info)
  if (!p) return { model: 'FREE', pricePerUnitUsd: null, events: [], minimalMaxTotalChargeUsd: null }
  const model = typeof p.pricingModel === 'string' ? p.pricingModel : 'UNKNOWN'
  const events: PricingEvent[] = []
  const charge = obj(obj(p.pricingPerEvent)?.actorChargeEvents)
  if (charge) {
    for (const [name, raw] of Object.entries(charge)) {
      const e = obj(raw)
      if (!e) continue
      const price = eventPrice(e, tier)
      if (price === null) continue
      const title = typeof e.eventTitle === 'string' ? e.eventTitle : name
      events.push({
        name,
        title,
        priceUsd: price,
        primary: e.isPrimaryEvent === true,
        oneTime: e.isOneTimeEvent === true || /(^|-)start$/.test(name) || /\bstart\b/i.test(title),
      })
    }
  }
  return {
    model,
    pricePerUnitUsd: num(p.pricePerUnitUsd),
    events,
    minimalMaxTotalChargeUsd: num(p.minimalMaxTotalChargeUsd),
  }
}

/** The pricing in force now: the last entry of an actor's `pricingInfos` that has started. */
export function currentPricingInfo(infos: unknown, now = new Date()): unknown {
  if (!Array.isArray(infos) || !infos.length) return null
  const started = infos.filter((i) => {
    const s = obj(i)?.startedAt
    return typeof s !== 'string' || Date.parse(s) <= now.getTime()
  })
  return started.at(-1) ?? null
}

/** The per-result price of an event-priced actor: the primary event, else the priciest repeating one. */
export function primaryEvent(p: Pricing): PricingEvent | null {
  const repeating = p.events.filter((e) => !e.oneTime)
  return repeating.find((e) => e.primary) ?? [...repeating].sort((a, b) => b.priceUsd - a.priceUsd)[0] ?? null
}

/** One-line price for a shortlist: "$0.004 / Scraped place", "$2.00 / 1,000 results", "pay per usage". */
export function describePrice(p: Pricing): string {
  switch (p.model) {
    case 'PAY_PER_EVENT': {
      const e = primaryEvent(p)
      return e ? `$${e.priceUsd} per ${e.title.toLowerCase()} (pay per event)` : 'pay per event'
    }
    case 'PRICE_PER_DATASET_ITEM':
      return p.pricePerUnitUsd !== null ? `$${round(p.pricePerUnitUsd * 1000)} per 1,000 results` : 'pay per result'
    case 'FREE':
      return 'pay per usage (platform compute)'
    case 'FLAT_PRICE_PER_MONTH':
      return p.pricePerUnitUsd !== null ? `rental $${p.pricePerUnitUsd}/month (not runnable from Lume)` : 'rental (not runnable from Lume)'
    default:
      return `${p.model} (not runnable from Lume)`
  }
}

export interface RunOptions {
  timeout: number
  memory?: number
  maxItems?: number
  maxTotalChargeUsd: number
}

export interface PlanInput {
  /** Owner's budget for this run; never above the cap. Defaults to the cap. */
  maxChargeUsd?: number
  /** Expected results (the owner's volume), for the estimate only. */
  expectedItems?: number
  timeoutSecs?: number
  /** From the actor (defaultRunOptions / actorDefinition). */
  defaultMemoryMb?: number | null
  minMemoryMb?: number | null
}

export type RunPlan =
  | { ok: true; model: string; options: RunOptions; budgetUsd: number; estimateUsd: number; estimateNote: string }
  | { ok: false; reason: string }

const round = (n: number) => Math.round(n * 100) / 100

export function planRun(p: Pricing, input: PlanInput = {}, capUsd = ACTOR_RUN_CAP_USD): RunPlan {
  const budget = round(Math.min(capUsd, input.maxChargeUsd ?? capUsd))
  if (!(budget > 0)) return { ok: false, reason: 'budget must be above $0' }
  if (input.maxChargeUsd !== undefined && input.maxChargeUsd > capUsd) {
    return { ok: false, reason: `budget $${input.maxChargeUsd} is above the $${capUsd} cap per run` }
  }
  const timeout = Math.min(MAX_TIMEOUT_SECS, Math.max(60, Math.floor(input.timeoutSecs ?? DEFAULT_TIMEOUT_SECS)))
  const expected = input.expectedItems && input.expectedItems > 0 ? Math.floor(input.expectedItems) : null

  switch (p.model) {
    case 'PAY_PER_EVENT': {
      if (p.minimalMaxTotalChargeUsd !== null && p.minimalMaxTotalChargeUsd > budget) {
        return { ok: false, reason: `this actor needs a budget of at least $${p.minimalMaxTotalChargeUsd}` }
      }
      const ev = primaryEvent(p)
      if (!ev) return { ok: false, reason: 'pay-per-event actor with no priced result event; cost cannot be estimated' }
      const start = p.events.filter((e) => e.oneTime).reduce((s, e) => s + e.priceUsd, 0)
      const raw = expected !== null ? start + ev.priceUsd * expected : null
      const estimate = raw !== null ? round(Math.min(raw, budget)) : budget
      const fits = ev.priceUsd > 0 ? Math.floor((budget - start) / ev.priceUsd) : null
      return {
        ok: true,
        model: p.model,
        options: { timeout, maxTotalChargeUsd: budget },
        budgetUsd: budget,
        estimateUsd: estimate,
        estimateNote:
          raw === null
            ? `up to $${budget}; $${ev.priceUsd} per ${ev.title.toLowerCase()}`
            : `${expected} × $${ev.priceUsd} per ${ev.title.toLowerCase()}${start ? ` + $${round(start)} start` : ''}` +
              (raw > budget && fits !== null ? `; the cap stops it at about ${fits} results` : ''),
      }
    }
    case 'PRICE_PER_DATASET_ITEM': {
      const price = p.pricePerUnitUsd
      if (!price || price <= 0) return { ok: false, reason: 'pay-per-result actor with no price per result' }
      const maxItems = Math.floor(budget / price)
      if (maxItems < 1) return { ok: false, reason: `one result costs $${price}, above the budget` }
      const charged = expected !== null ? Math.min(expected, maxItems) : maxItems
      return {
        ok: true,
        model: p.model,
        options: { timeout, maxItems, maxTotalChargeUsd: budget },
        budgetUsd: budget,
        estimateUsd: round(charged * price),
        estimateNote:
          `${charged} results × $${price}` + (expected !== null && expected > maxItems ? `; capped at ${maxItems} results` : ''),
      }
    }
    case 'FREE': {
      const min = input.minMemoryMb ?? 128
      let memory = pow2Floor(Math.min(USAGE_MEMORY_MAX_MB, Math.max(128, input.defaultMemoryMb ?? 1024)))
      if (memory < min) memory = pow2Ceil(min)
      if (memory > USAGE_MEMORY_MAX_MB) return { ok: false, reason: `actor needs at least ${min} MB; compute cost cannot be capped` }
      const gb = memory / 1024
      // Longest run that stays inside the budget at the worst CU price.
      const affordable = Math.floor((budget / (gb * CU_USD_MAX)) * 3600)
      const t = Math.min(timeout, affordable)
      if (t < 60) return { ok: false, reason: 'budget too small for even a one-minute run' }
      const worst = round(gb * (t / 3600) * CU_USD_MAX)
      return {
        ok: true,
        model: p.model,
        options: { timeout: t, memory, maxTotalChargeUsd: budget },
        budgetUsd: budget,
        estimateUsd: worst,
        estimateNote: `pay per usage: at most ${gb} GB × ${round(t / 3600)} h of compute ≈ $${worst} worst case (datacenter proxy included in plan)`,
      }
    }
    case 'FLAT_PRICE_PER_MONTH':
      return { ok: false, reason: 'rental actors charge a monthly fee; Lume cannot cap that per run' }
    default:
      return { ok: false, reason: `unknown pricing model ${p.model}; cost cannot be capped` }
  }
}

function pow2Floor(mb: number): number {
  let m = 128
  while (m * 2 <= mb) m *= 2
  return m
}

function pow2Ceil(mb: number): number {
  let m = 128
  while (m < mb) m *= 2
  return m
}
