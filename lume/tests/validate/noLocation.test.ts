import { describe, expect, it } from 'vitest'
import { noLocationName, rankTemplates, stripLocationVariants } from '@/lib/validate/noLocation'

const seq = (steps: { subject?: string; body?: string }[][]) => [{ steps: steps.map((variants) => ({ type: 'email', delay: 2, variants })) }]

describe('stripLocationVariants', () => {
  it('drops variants that use {{location}} and keeps the rest', () => {
    const r = stripLocationVariants(seq([[{ subject: 'PMs in {{ Location }}', body: 'x' }, { subject: 'quick q', body: 'hi {{firstName}}' }], [{ subject: '', body: 'follow up' }]]))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.removed).toBe(1)
    expect(r.kept).toBe(2)
    expect(r.sequences[0].steps![0].variants).toHaveLength(1)
    expect(r.sequences[0].steps![0].type).toBe('email')
  })
  it('refuses when a step would be left with no variant', () => {
    expect(stripLocationVariants(seq([[{ subject: 'a', body: 'b' }], [{ body: 'in {{location}}' }]]))).toEqual({ ok: false, reason: 'step_needs_location', step: 2 })
  })
  it('refuses when there is no copy', () => {
    expect(stripLocationVariants([])).toEqual({ ok: false, reason: 'no_sequence' })
    expect(stripLocationVariants(null)).toEqual({ ok: false, reason: 'no_sequence' })
  })
})

describe('naming and templates', () => {
  it('names the sibling after the main campaign', () => {
    expect(noLocationName('Zenport Campaign')).toBe('Zenport Campaign — No Location')
  })
  it('puts no-location templates first', () => {
    expect(rankTemplates([{ name: 'Zenport Campaign' }, { name: 'Zenport Campaign — No Location' }]).map((t) => t.name)).toEqual(['Zenport Campaign — No Location', 'Zenport Campaign'])
  })
})
