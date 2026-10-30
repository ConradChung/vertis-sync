import { describe, expect, it } from 'vitest'
import { loadSopLibrary } from '@/lib/copy/sop'
import { sopGate } from '@/lib/copy/sopGate'

// The committed SOPs: the base is still a placeholder, Kaspen is real.
const body1 = (extra: string) =>
  `Hi {{firstName}},\n\nWithout a GM, the owner becomes the middle manager: every late rent call, every vendor quote, every lease question ends up with you.\n\nI run about 1,000 doors in Vancouver and was that middle manager for years. Kaspen works inside your software and handles the leasing, maintenance and finance work. ${extra}\n\nIs maintenance or leasing the bigger fire right now?\n\nFrank Jing`

describe('sopGate with the committed SOPs', () => {
  it('the base is a placeholder (the premise of the downgrade)', () => {
    expect(loadSopLibrary().base.rules.placeholder).toBe(true)
  })

  it('a non-Kaspen campaign: placeholder base violations are warnings only', () => {
    const g = sopGate({ name: 'Roofers Austin' }, [{ variants: [{ subject: 'Quick Question', body: 'Just checking in. Synergy!' }] }])
    expect(g.client).toBeNull()
    expect(g.blocking).toEqual([])
    expect(g.warnings.map((v) => v.rule)).toEqual(expect.arrayContaining(['banned_phrase', 'word_count', 'subject_casing']))
    expect(g.warnings.every((v) => v.severity === 'warning')).toBe(true)
  })

  it('the Kaspen campaign: Kaspen rules block, base-only rules (e.g. "synergy") warn', () => {
    const g = sopGate({ name: 'Zenport' }, [{ variants: [{ subject: 'no general manager', body: body1('Real synergy, reach out.') }] }])
    expect(g.client).toBe('kaspen')
    expect(g.blocking.map((v) => [v.rule, v.message])).toEqual([['banned_phrase', 'body uses the banned phrase "reach out"']])
    expect(g.warnings.map((v) => [v.rule, v.message])).toEqual(
      expect.arrayContaining([['banned_phrase', 'body uses the banned phrase "synergy"']])
    )
  })
})
