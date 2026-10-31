import { describe, expect, it } from 'vitest'
import { loadSopLibrary } from '@/lib/copy/sop'
import { sopGate } from '@/lib/copy/sopGate'

// The committed SOPs: the base is the owner's general playbook (blocks), Kaspen overlays it.
const body1 = (extra: string) =>
  `Hi {{firstName}},\n\nWithout a GM, the owner becomes the middle manager: every late rent call, every vendor quote, every lease question ends up with you.\n\nI run about 1,000 doors in Vancouver and was that middle manager for years. Kaspen works inside your software and handles the leasing, maintenance and finance work. ${extra}\n\nIs maintenance or leasing the bigger fire right now?\n\nFrank Jing`

describe('sopGate with the committed SOPs', () => {
  it('the base is the real playbook, not a placeholder', () => {
    expect(loadSopLibrary().base.rules.placeholder).toBe(false)
  })

  it('a non-Kaspen campaign: base violations block', () => {
    const g = sopGate({ name: 'Roofers Austin' }, [{ variants: [{ subject: 'Quick Question', body: 'Just checking in. Reach out!' }] }])
    expect(g.client).toBeNull()
    expect(g.blocking.map((v) => v.rule)).toEqual(expect.arrayContaining(['banned_phrase', 'word_count', 'subject_casing', 'no_exclamation']))
    expect(g.warnings.every((v) => v.severity === 'warning')).toBe(true)
  })

  it('a clean non-Kaspen step 1 passes the base', () => {
    const body =
      'Hi {{firstName}},\n\nMost owners end up as the middle manager of their own portfolio: every late rent call, every vendor quote and every lease question lands on them.\n\nI ran a portfolio for years and built a tool that takes the maintenance intake and the leasing follow-ups off that desk, inside the software you already use.\n\nWhich part of ops still lands on your desk?\n\nSam'
    const g = sopGate({ name: 'Roofers Austin' }, [{ variants: [{ subject: 'the middle manager', body }] }])
    expect(g.blocking).toEqual([])
  })

  it('the Kaspen campaign: Kaspen rules and the base banned phrases both block', () => {
    const g = sopGate({ name: 'Zenport' }, [{ variants: [{ subject: 'no general manager', body: body1('Touching base, reach out.') }] }])
    expect(g.client).toBe('kaspen')
    expect(g.blocking.map((v) => v.message).sort()).toEqual([
      'body uses the banned phrase "reach out"',
      'body uses the banned phrase "touching base"',
    ])
  })

  it('the Kaspen campaign of the live pending edit (bcf7a6d2…): {{jurisdiction_line}} blocks', () => {
    const g = sopGate({ id: 'bcf7a6d2-1302-47fc-ae77-9d2a760c91c1' }, [{ variants: [{ subject: 'no general manager', body: body1('{{jurisdiction_line}}') }] }])
    expect(g.client).toBe('kaspen')
    expect(g.blocking.map((v) => v.message)).toContain('body uses {{jurisdiction_line}}: retired, use {{compliance_law}}')
  })
})
