import { describe, expect, it } from 'vitest'
import {
  diffSequences,
  diffSummary,
  htmlToText,
  previewVariables,
  readInstantlySteps,
  sequenceProblems,
  textToHtml,
  toEditSteps,
  toInstantlySteps,
  variablesIn,
  type EditStep,
} from '@/lib/campaigns/sequence'

const BODY = {
  name: 'Scaleport',
  sequences: [
    {
      steps: [
        {
          type: 'email',
          delay: 0,
          id: 'ignored',
          variants: [
            { subject: 'Hi {{firstName}}', body: '<div>Hey {{firstName}},</div><div><br/></div><div>Quick <b>one</b> &amp; done.</div>' },
            { subject: 'Alt', body: 'plain\ntext', v_disabled: true },
          ],
        },
        { type: 'email', delay: 3, delay_unit: 'days', variants: [{ subject: '', body: '<p>Bump</p>' }] },
      ],
    },
  ],
}

describe('reading and converting', () => {
  it('keeps only documented fields of the first sequence', () => {
    const steps = readInstantlySteps(BODY)
    expect(steps).toHaveLength(2)
    expect(steps[0]).toEqual({
      type: 'email',
      delay: 0,
      variants: [
        { subject: 'Hi {{firstName}}', body: BODY.sequences[0].steps[0].variants[0].body },
        { subject: 'Alt', body: 'plain\ntext', v_disabled: true },
      ],
    })
    expect(steps[1].delay_unit).toBe('days')
    expect(readInstantlySteps({})).toEqual([])
    expect(readInstantlySteps({ sequences: [{}] })).toEqual([])
  })

  it('HTML to text keeps line breaks; plain-text bodies keep their newlines', () => {
    expect(htmlToText(BODY.sequences[0].steps[0].variants[0].body)).toBe('Hey {{firstName}},\n\nQuick one & done.')
    expect(htmlToText('plain\ntext')).toBe('plain\ntext')
    expect(htmlToText('<p>Bump</p>')).toBe('Bump')
  })

  it('text to HTML escapes and round-trips through htmlToText', () => {
    const t = 'Hi <there> & you\n\nLine 3'
    const html = textToHtml(t)
    expect(html).toBe('<div>Hi &lt;there&gt; &amp; you</div><div><br/></div><div>Line 3</div>')
    expect(htmlToText(html)).toBe(t)
  })

  it('untouched variants keep their original HTML; edited ones are re-rendered', () => {
    const orig = readInstantlySteps(BODY)
    const edit = toEditSteps(orig)
    edit[1].variants[0].body = 'Bump again'
    const out = toInstantlySteps(edit, orig)
    expect(out[0].variants[0].body).toBe(orig[0].variants[0].body)
    expect(out[0].variants[1]).toEqual({ subject: 'Alt', body: 'plain\ntext', v_disabled: true })
    expect(out[1].variants[0].body).toBe('<div>Bump again</div>')
    expect(out[0].delay_unit).toBe('days')
  })

  it('without refs (agent rewrite) the same position is the comparison', () => {
    const orig = readInstantlySteps(BODY)
    const edit: EditStep[] = toEditSteps(orig).map((s) => ({ ...s, variants: s.variants.map((v) => ({ subject: v.subject, body: v.body, disabled: v.disabled })) }))
    const out = toInstantlySteps(edit, orig)
    expect(out[0].variants[0].body).toBe(orig[0].variants[0].body)
  })
})

describe('validation', () => {
  const ok: EditStep[] = [{ delay: 0, delay_unit: 'days', variants: [{ subject: 'Hi', body: 'Body' }] }]
  it('accepts a valid sequence', () => expect(sequenceProblems(ok)).toEqual([]))
  it('flags empty bodies, missing first subject, all-disabled steps and >366 days', () => {
    const bad: EditStep[] = [
      { delay: 0, delay_unit: 'days', variants: [{ subject: '', body: ' ' }] },
      { delay: 400, delay_unit: 'days', variants: [{ subject: '', body: 'x', disabled: true }] },
    ]
    const p = sequenceProblems(bad)
    expect(p).toContain('Step 1: the email body is empty.')
    expect(p).toContain('Step 1: the first email needs a subject.')
    expect(p).toContain('Step 2: at least one variant must be enabled.')
    expect(p).toContain('The delays add up to more than 366 days.')
  })
})

describe('diff', () => {
  const before: EditStep[] = [
    { delay: 0, delay_unit: 'days', variants: [{ subject: 'Hi', body: 'One' }, { subject: 'B', body: 'Two' }] },
    { delay: 3, delay_unit: 'days', variants: [{ subject: '', body: 'Bump' }] },
  ]
  it('reports nothing for identical sequences', () => {
    expect(diffSequences(before, structuredClone(before))).toEqual([])
    expect(diffSummary([])).toBe('no changes')
  })
  it('reports edited fields, delay, removed variants and added steps', () => {
    const after: EditStep[] = [
      { delay: 0, delay_unit: 'days', variants: [{ subject: 'Hello', body: 'One' }] },
      { delay: 5, delay_unit: 'days', variants: [{ subject: '', body: 'Bump' }] },
      { delay: 2, delay_unit: 'days', variants: [{ subject: '', body: 'Last' }] },
    ]
    const d = diffSequences(before, after)
    expect(d[0]).toEqual({
      step: 1,
      change: 'changed',
      variants: [
        { variant: 'A', change: 'changed', fields: [{ field: 'subject', before: 'Hi', after: 'Hello' }] },
        { variant: 'B', change: 'removed', before: { subject: 'B', body: 'Two' } },
      ],
    })
    expect(d[1]).toEqual({ step: 2, change: 'changed', delay: { before: 'wait 3 days', after: 'wait 5 days' }, variants: [] })
    expect(d[2]).toMatchObject({ step: 3, change: 'added' })
    expect(diffSummary(d)).toBe('2 steps edited, 1 added')
  })
  it('reports a removed step', () => {
    expect(diffSequences(before, before.slice(0, 1))).toEqual([{ step: 2, change: 'removed', before: before[1] }])
  })
})

describe('variables', () => {
  it('fills known variables and marks unknown ones', () => {
    expect(previewVariables('Hi {{firstName}} at {{ companyName }} {{foo}}')).toBe('Hi Alex at Northwind Roofing [foo]')
    expect(variablesIn('{{a}} {{b}} {{a}}')).toEqual(['a', 'b'])
  })
})
