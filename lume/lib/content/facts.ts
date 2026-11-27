import type { Slot, Variant } from '@/lib/content/slots'

/**
 * Fact picking (pure). A draft may state only what is in the facts bank.
 * Each draft gets one lead fact (the thing the post is about), at most one
 * supporting number, the offer (the closing ask) and the quote facts
 * (product line, tagline) as background. A fact that led a draft in the last
 * 21 days can't lead again; rejected and superseded drafts don't count
 * (nobody posted them).
 *
 * Proof and the Hand-raiser story week prefer facts with a story attached:
 * an owner-added `detail` first, then story facts and numbers that state
 * their cause ("after bringing AI into leasing"), then bare results.
 */

export const FACT_KINDS = ['number', 'story', 'quote', 'offer', 'objection'] as const
export type FactKind = (typeof FACT_KINDS)[number]
export const isFactKind = (v: unknown): v is FactKind => typeof v === 'string' && (FACT_KINDS as readonly string[]).includes(v)

export interface Fact {
  id: number
  kind: FactKind
  text: string
  source: string
  active: boolean
  /** Optional: the real story behind the fact, added by the owner. */
  detail?: string | null
}

export interface LeadUse {
  lead_fact_id: number | null
  created_at: string
  status: string
}

export const REUSE_WINDOW_DAYS = 21

export interface FactPick {
  lead: Fact
  supporting: Fact | null
  offer: Fact
  background: Fact[]
}

/** Facts that speak to an owner's side of the table. */
const OWNER_TOPIC = /\b(payroll|headcount|NOI|operating income|hours saved|in-house|staff|cost)/i

function leadKinds(slot: Slot, variant: Variant | null): FactKind[] {
  if (slot === 'proof') return ['number', 'story']
  if (slot === 'owner_view') return ['story', 'number', 'objection']
  return variant === 'breakdown' ? ['number'] : ['story', 'number']
}

const NOT_COUNTED = new Set(['rejected', 'superseded'])
const CAUSE = /\b(after (bringing|adding|switching|moving|we)|led to|because|by bringing|when we)\b/i

/** 0: owner-added story; 1: a story fact or a number that states its cause; 2: a bare result. */
export function storyScore(f: Fact): number {
  if (f.detail && f.detail.trim()) return 0
  return f.kind === 'story' || CAUSE.test(f.text) ? 1 : 2
}

/** Lead fact ids used inside the reuse window (rejected and superseded drafts excluded). */
export function recentLeadIds(uses: LeadUse[], now: Date, days = REUSE_WINDOW_DAYS): Set<number> {
  const from = now.getTime() - days * 86_400_000
  const ids = new Set<number>()
  for (const u of uses) {
    if (u.lead_fact_id === null || NOT_COUNTED.has(u.status)) continue
    if (new Date(u.created_at).getTime() >= from) ids.add(u.lead_fact_id)
  }
  return ids
}

function lastLed(uses: LeadUse[]): Map<number, number> {
  const m = new Map<number, number>()
  for (const u of uses) {
    if (u.lead_fact_id === null || NOT_COUNTED.has(u.status)) continue
    const t = new Date(u.created_at).getTime()
    if (t > (m.get(u.lead_fact_id) ?? -Infinity)) m.set(u.lead_fact_id, t)
  }
  return m
}

export function pickFacts(
  slot: Slot,
  variant: Variant | null,
  facts: Fact[],
  uses: LeadUse[],
  now: Date
): FactPick | { error: string } {
  const active = facts.filter((f) => f.active)
  const offer = active.filter((f) => f.kind === 'offer').sort((a, b) => b.id - a.id)[0]
  if (!offer) return { error: 'no_active_offer_fact' }
  const blocked = recentLeadIds(uses, now)
  const kinds = leadKinds(slot, variant)
  const led = lastLed(uses)
  const rank = (f: Fact) => {
    const kindRank = kinds.indexOf(f.kind)
    const topic = slot === 'owner_view' && OWNER_TOPIC.test(f.text) ? 0 : 1
    const story = slot === 'proof' || (slot === 'hand_raiser' && variant === 'story') ? storyScore(f) : 0
    return [topic, story, kindRank, led.get(f.id) ?? -Infinity, f.id] as const
  }
  const cmp = (a: Fact, b: Fact) => {
    const ra = rank(a)
    const rb = rank(b)
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] < rb[i] ? -1 : 1
    return 0
  }
  // Proof is a result: a story fact can lead it only when it has an outcome ("led to a 153-property deal").
  const eligible = (f: Fact) => kinds.includes(f.kind) && !(slot === 'proof' && f.kind === 'story' && !CAUSE.test(f.text) && !f.detail?.trim())
  const candidates = active.filter((f) => eligible(f) && !blocked.has(f.id)).sort(cmp)
  const lead = candidates[0]
  if (!lead) return { error: `no_fresh_lead_fact_for_${slot}` }

  // One supporting number for the Owner view when the lead is a story: the
  // owner-topic number led least recently. Proof and Hand-raiser stay on one fact.
  let supporting: Fact | null = null
  if (slot === 'owner_view' && lead.kind !== 'number') {
    supporting =
      active
        .filter((f) => f.kind === 'number' && f.id !== lead.id && OWNER_TOPIC.test(f.text))
        .sort((a, b) => (led.get(a.id) ?? -Infinity) - (led.get(b.id) ?? -Infinity) || a.id - b.id)[0] ?? null
  }
  const background = active.filter((f) => f.kind === 'quote')
  return { lead, supporting, offer, background }
}

export const pickedFacts = (p: FactPick): Fact[] => [p.lead, ...(p.supporting ? [p.supporting] : []), p.offer, ...p.background]
