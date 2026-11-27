import { describe, expect, it } from 'vitest'
import { weekContext, weekStart, type RecentDraft } from '@/lib/content/engine'
import { buildUser } from '@/lib/content/prompt'
import { FACTS, fact } from './fixtures'

const d = (id: number, run_date: string, body: string, status = 'accepted'): RecentDraft => ({ id, slot: 'proof', status, run_date, body })

describe('week context', () => {
  it('weekStart is the Monday', () => {
    expect(weekStart('2026-11-26')).toBe('2026-11-23')
    expect(weekStart('2026-11-23')).toBe('2026-11-23')
    expect(weekStart('2026-11-29')).toBe('2026-11-23')
    expect(weekStart('2026-12-01')).toBe('2026-11-30')
  })

  it('tagline and built line count only for live drafts in the same week', () => {
    const tag = 'grow doors not payroll'
    const recent = [
      d(1, '2026-11-24', 'x Grow doors, not payroll. y'),
      d(2, '2026-11-25', 'So we built Kaspen.', 'superseded'),
      d(3, '2026-11-18', 'So we built Kaspen.'),
      d(4, '2026-11-25', 'never shown', 'rejected'),
    ]
    const w = weekContext(recent, '2026-11-26', tag)
    expect(w.taglineTaken).toBe(true)
    expect(w.builtTaken).toBe(false) // #2 superseded, #3 last week
    expect(w.recent.map((r) => r.id)).toEqual([1, 2, 3]) // all non-rejected drafts are shown to the model
    expect(weekContext(recent, '2026-12-01', tag).taglineTaken).toBe(false)
  })

  it('the prompt shows recent drafts, the week flags and an owner-added story', () => {
    const lead = { ...fact(3), detail: 'They stopped posting for a second leasing agent.' }
    const pick = { lead, supporting: null, offer: fact(1), background: FACTS.filter((f) => f.kind === 'quote') }
    const u = buildUser('proof', null, pick, undefined, { recent: [{ id: 9, slot: 'owner_view', body: 'Earlier draft text.' }], taglineTaken: true, builtTaken: true })
    expect(u).toContain('Story behind it (real, from the owner): They stopped posting for a second leasing agent.')
    expect(u).toContain('<draft id="9" slot="owner_view">\nEarlier draft text.\n</draft>')
    expect(u).toContain('The tagline is already used')
    expect(u).toContain('"we built Kaspen" line is already used')
    expect(u).toContain('one sentence in your own words at most, never its lists')
  })
})
