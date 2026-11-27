import { describe, expect, it } from 'vitest'
import { pickFacts, recentLeadIds, storyScore, type LeadUse } from '@/lib/content/facts'
import { FACTS } from './fixtures'

const now = new Date('2026-12-01T14:30:00Z')
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString()
const use = (id: number, days: number, status = 'accepted'): LeadUse => ({ lead_fact_id: id, created_at: daysAgo(days), status })
const pick = (slot: 'proof' | 'owner_view' | 'hand_raiser', variant: 'breakdown' | 'story' | null, uses: LeadUse[] = [], facts = FACTS) => {
  const p = pickFacts(slot, variant, facts, uses, now)
  if ('error' in p) throw new Error(p.error)
  return p
}

describe('fact picking', () => {
  it('Proof prefers a fact with a story attached: days on market (after AI in leasing), then the 9:57 PM call', () => {
    expect(pick('proof', null).lead.id).toBe(8)
    expect(pick('proof', null, [use(8, 2)]).lead.id).toBe(9)
    // Bare results only once those led recently.
    expect([3, 4, 5, 6, 7]).toContain(pick('proof', null, [use(8, 2), use(9, 2)]).lead.id)
  })

  it('an owner-added detail puts a fact first', () => {
    const facts = FACTS.map((f) => (f.id === 3 ? { ...f, detail: 'They stopped hiring a second leasing agent.' } : f))
    expect(pick('proof', null, [], facts).lead.id).toBe(3)
    expect(storyScore(facts[2])).toBe(0)
    expect(storyScore(FACTS[7])).toBe(1)
    expect(storyScore(FACTS[2])).toBe(2)
  })

  it('Proof brings the offer and quotes along', () => {
    const p = pick('proof', null)
    expect(p.offer.id).toBe(1)
    expect(p.background.map((f) => f.id)).toEqual([2, 11])
    expect(p.supporting).toBeNull()
  })

  it("Owner view prefers payroll / NOI facts, story first, with one supporting owner number", () => {
    const p = pick('owner_view', null)
    expect(p.lead.id).toBe(10) // the asset manager, NOI
    expect(p.supporting?.kind).toBe('number')
    expect([3, 4]).toContain(p.supporting!.id)
  })

  it('Hand-raiser: breakdown leads with a number, story week with a story', () => {
    expect(pick('hand_raiser', 'breakdown').lead.kind).toBe('number')
    expect(pick('hand_raiser', 'story').lead.kind).toBe('story')
  })

  it('reuse window: a fact that led in the last 21 days does not lead again', () => {
    const first = pick('proof', null).lead.id
    const second = pick('proof', null, [use(first, 20)]).lead.id
    expect(second).not.toBe(first)
    // 22 days ago is outside the window: with every other number fresh, it leads again.
    const others = FACTS.filter((f) => (f.kind === 'number' || f.kind === 'story') && f.id !== first).map((f) => use(f.id, 5))
    expect(pick('proof', null, [use(first, 22), ...others]).lead.id).toBe(first)
    expect(pickFacts('proof', null, FACTS, [use(first, 20), ...others], now)).toEqual({ error: 'no_fresh_lead_fact_for_proof' })
    // Rejected and superseded drafts never count.
    expect(pick('proof', null, [use(first, 1, 'rejected')]).lead.id).toBe(first)
    expect(pick('proof', null, [use(first, 1, 'superseded')]).lead.id).toBe(first)
    expect(recentLeadIds([use(3, 5), use(4, 30), use(5, 1, 'rejected')], now)).toEqual(new Set([3]))
  })

  it('prefers facts never led, then the least recently led', () => {
    const numbers = FACTS.filter((f) => f.kind === 'number' && storyScore(f) === 2).map((f) => f.id)
    const storied = [8, 9].map((id) => use(id, 2))
    const uses = [...storied, ...numbers.slice(0, -1).map((id, i) => use(id, 30 + i))]
    expect(pick('proof', null, uses).lead.id).toBe(numbers[numbers.length - 1])
    const allOld = [...storied, ...numbers.map((id, i) => use(id, 30 + i))]
    expect(pick('proof', null, allOld).lead.id).toBe(numbers[numbers.length - 1]) // oldest use = largest days
  })

  it('errors when every eligible fact led recently, or there is no offer', () => {
    const uses = FACTS.filter((f) => f.kind === 'number' || f.kind === 'story').map((f) => use(f.id, 3))
    expect(pickFacts('proof', null, FACTS, uses, now)).toEqual({ error: 'no_fresh_lead_fact_for_proof' })
    expect(pickFacts('proof', null, FACTS.filter((f) => f.kind !== 'offer'), [], now)).toEqual({ error: 'no_active_offer_fact' })
  })

  it('ignores retired facts', () => {
    const facts = FACTS.map((f) => (f.kind === 'story' ? { ...f, active: false } : f))
    expect(pick('hand_raiser', 'story', [], facts).lead.kind).toBe('number')
  })
})
