import { describe, expect, it } from 'vitest'
import { SopRulesSchema, type SopRules } from '@/lib/copy/sop'
import { formatViolation, isBlocking, lintSequence, wordCount, type LintStep } from '@/lib/copy/sopLint'

const RULES: SopRules = SopRulesSchema.parse({
  version: 1,
  placeholder: false,
  banned_phrases: ['just checking in', "hope you're well", 'game-changer', 'leverage'],
  word_count: { step1: { min: 8, max: 40 }, followup: { min: 4, max: 25 } },
  subject: { casing: 'lowercase', max_words: 5, allowed_capitalized: ['PMS', 'I'] },
  proof_points: [
    { id: 'acme', patterns: ['Acme Property Group', '\\bAcme\\b'] },
    { id: 'metric_30', patterns: ['30% fewer after-hours calls'] },
  ],
  personalization_fields: ['hook', 'city', 'door_count', 'pms', 'open_role'],
  max_personalization_fields_per_email: 1,
  step1_cta: {
    forbid_yes_no_meeting: true,
    meeting_words: ['a call', 'quick call', 'meeting', 'demo', 'a chat', 'hop on'],
    meeting_patterns: ['\\b(10|15|20|30)[ -]?min(ute)?s?\\b'],
  },
  fallbacks: { open_role: 'a', door_count: 'b', pms: 'c', jurisdiction: 'd', compliance_law: 'd', generic: 'e' },
})

const v = (subject: string, body: string, disabled?: boolean) => ({ subject, body, ...(disabled ? { disabled } : {}) })

/** A sequence that follows every rule: the baseline the failing cases mutate. */
function clean(): LintStep[] {
  return [
    {
      variants: [
        v('after-hours calls in {{city}}', 'Hi {{firstName}},\n\nAcme Property Group cut their overnight maintenance load in half last quarter.\n\nWorth sending over how they did it?'),
        v('your on-call rotation', 'Hi {{firstName}},\n\nMost managers we talk to spend nights fielding maintenance calls themselves.\n\nInterested in how others handle it?'),
      ],
    },
    { variants: [v('', 'One more thought: we saw 30% fewer after-hours calls once triage moved off the owner.')] },
    { variants: [v('', 'Should I close the loop on this, {{firstName}}?')] },
  ]
}

const rules = (vs: ReturnType<typeof lintSequence>) => vs.map((x) => x.rule)

describe('lintSequence: clean sequences pass', () => {
  it('passes the baseline (A/B variants, same-thread follow-ups, non-personal vars)', () => {
    expect(lintSequence(clean(), RULES)).toEqual([])
  })

  it('passes with every rule relaxed to its edge', () => {
    const s: LintStep[] = [{ variants: [v('a b c d e', Array(8).fill('word').join(' '))] }, { variants: [v('', Array(25).fill('word').join(' '))] }]
    expect(lintSequence(s, RULES)).toEqual([])
  })

  it('passes an empty-subject follow-up, an allowed capitalized word and a non-meeting question in step 1', () => {
    const s = clean()
    s[0].variants[0].subject = 'your PMS and nights'
    s[0].variants[0].body = 'Hi {{firstName}},\n\nWho handles maintenance requests that come in after 6pm at {{companyName}} today?'
    expect(lintSequence(s, RULES)).toEqual([])
  })

  it('ignores disabled variants (Instantly never sends them)', () => {
    const s = clean()
    s[0].variants.push(v('Just Checking In', 'just checking in, hop on a call?', true))
    expect(lintSequence(s, RULES)).toEqual([])
  })
})

describe('banned_phrase', () => {
  it('matches case-insensitively in subject and body, naming step and variant', () => {
    const s = clean()
    s[0].variants[1].body = s[0].variants[1].body.replace('Most managers', 'Just Checking In: most managers')
    s[1].variants[0].body += ' A real game-changer.'
    const out = lintSequence(s, RULES)
    expect(out).toEqual([
      expect.objectContaining({ rule: 'banned_phrase', step: 1, variant: 'B', excerpt: expect.stringContaining('Just Checking In') }),
      expect.objectContaining({ rule: 'banned_phrase', step: 2, variant: 'A', excerpt: expect.stringContaining('game-changer') }),
    ])
    expect(out[0].message).toMatch(/"just checking in"/)
  })

  it('respects word boundaries (leverage ≠ leveraged? no: leveraged is a different word)', () => {
    const s = clean()
    s[1].variants[0].body += ' Our leveraged buyout team.'
    expect(lintSequence(s, RULES)).toEqual([])
    s[1].variants[0].body += ' We leverage data.'
    expect(rules(lintSequence(s, RULES))).toEqual(['banned_phrase'])
  })

  it("normalises curly apostrophes and line breaks inside a phrase", () => {
    const s = clean()
    s[1].variants[0].body = 'Hope you’re\nwell. ' + s[1].variants[0].body
    expect(rules(lintSequence(s, RULES))).toEqual(['banned_phrase'])
  })
})

describe('word_count', () => {
  it('uses the step-1 range for step 1 and the follow-up range after', () => {
    const s = clean()
    s[0].variants[0].body = 'Hi {{firstName}}, quick note here.' // 5 words < 8
    s[2].variants[0].body = Array(26).fill('word').join(' ')
    const out = lintSequence(s, RULES)
    expect(out.map((x) => [x.rule, x.step, x.variant])).toEqual([
      ['word_count', 1, 'A'],
      ['word_count', 3, 'A'],
    ])
    expect(out[0].message).toMatch(/5 words.*8-40/)
    expect(out[1].message).toMatch(/26 words.*4-25/)
  })

  it('counts a {{variable}} as one word and ignores punctuation-only tokens', () => {
    expect(wordCount('Hi {{ firstName }} — how are   you?')).toBe(5)
    expect(wordCount('')).toBe(0)
  })
})

describe('proof_point_repeat', () => {
  it('flags a proof point used again in a later step of the thread', () => {
    const s = clean()
    s[2].variants[0].body = 'Acme saw the same thing. Should I close the loop?'
    const out = lintSequence(s, RULES)
    expect(out).toEqual([expect.objectContaining({ rule: 'proof_point_repeat', step: 3, variant: 'A', excerpt: expect.stringContaining('Acme') })])
    expect(out[0].message).toMatch(/acme.*already used in step 1/)
  })

  it('allows the same proof point in two variants of one step (a lead sees only one)', () => {
    const s = clean()
    s[0].variants[1].body = s[0].variants[1].body.replace('Most managers', 'Acme and most managers')
    expect(lintSequence(s, RULES)).toEqual([])
  })

  it('counts one proof point once per email however many of its patterns match', () => {
    const s = clean()
    s[1].variants[0].body = '30% fewer after-hours calls. Yes, 30% fewer after-hours calls.'
    expect(lintSequence(s, RULES)).toEqual([])
  })

  it('max_proof_points_per_email: flags an email citing more distinct proof points than allowed', () => {
    const s = clean()
    s[0].variants[0].body = s[0].variants[0].body.replace('last quarter', 'with 30% fewer after-hours calls')
    s[1].variants[0].body = 'One more thought: triage moved off the owner and nights got quiet again.'
    expect(lintSequence(s, RULES)).toEqual([])
    const out = lintSequence(s, { ...RULES, max_proof_points_per_email: 1 })
    expect(out).toEqual([expect.objectContaining({ rule: 'proof_points_per_email', step: 1, variant: 'A', excerpt: 'acme, metric_30' })])
  })
})

describe('subject', () => {
  it('lowercase: flags capitals except allowed words and {{variables}}', () => {
    const s = clean()
    s[0].variants[0].subject = 'After-hours calls in {{City}}'
    expect(lintSequence(s, RULES)).toEqual([expect.objectContaining({ rule: 'subject_casing', step: 1, variant: 'A', excerpt: 'After-hours calls in {{City}}' })])
  })

  it('sentence: first letter capital, no Title Case words', () => {
    const r: SopRules = { ...RULES, subject: { ...RULES.subject, casing: 'sentence', max_words: 6, allowed_capitalized: ['PMS'] } }
    const s = clean()
    s[0].variants[0].subject = 'After-hours calls and your PMS'
    s[0].variants[1].subject = 'Your On-Call Rotation'
    s[1].variants[0].subject = 'one more thought'
    expect(lintSequence(s, r).map((x) => [x.rule, x.step, x.variant])).toEqual([
      ['subject_casing', 1, 'B'],
      ['subject_casing', 2, 'A'],
    ])
  })

  it('any: never flags casing', () => {
    const s = clean()
    s[0].variants[0].subject = 'SHOUTY Subject'
    expect(lintSequence(s, { ...RULES, subject: { ...RULES.subject, casing: 'any' } })).toEqual([])
  })

  it('flags subjects over the word limit', () => {
    const s = clean()
    s[0].variants[1].subject = 'one two three four five six'
    expect(lintSequence(s, RULES)).toEqual([expect.objectContaining({ rule: 'subject_length', step: 1, variant: 'B' })])
  })
})

describe('personalization_fields', () => {
  it('flags more than the allowed personalization variables in one email (subject + body)', () => {
    const s = clean()
    s[0].variants[0].body = s[0].variants[0].body.replace('last quarter', 'with {{door_count}} doors')
    const out = lintSequence(s, RULES)
    expect(out).toEqual([expect.objectContaining({ rule: 'personalization_fields', step: 1, variant: 'A' })])
    expect(out[0].message).toMatch(/2 personalization variables \(\{\{city\}\}, \{\{door_count\}\}\); at most 1/)
  })

  it('counts a variable once however often it repeats, and ignores non-personal variables', () => {
    const s = clean()
    s[0].variants[0].body = s[0].variants[0].body.replace('last quarter', 'in {{ city }} for {{companyName}}')
    expect(lintSequence(s, RULES)).toEqual([])
  })
})

describe('step1_meeting_cta', () => {
  it.each([
    'Open to a quick call next week?',
    'Worth a 15 minutes chat?',
    'Can I show you a demo on Thursday?',
    'Would you hop on with me Tuesday?',
    'Got 10 min this week?',
  ])('flags a step-1 question asking for a meeting: %s', (cta) => {
    const s = clean()
    s[0].variants[1].body = s[0].variants[1].body.replace('Interested in how others handle it?', cta)
    expect(lintSequence(s, RULES)).toEqual([expect.objectContaining({ rule: 'step1_meeting_cta', step: 1, variant: 'B', excerpt: cta })])
  })

  it('allows meeting words in a statement, and meeting questions after step 1', () => {
    const s = clean()
    s[0].variants[1].body = s[0].variants[1].body.replace('Interested in how others handle it?', 'Happy to send a recording instead of a call. Interested?')
    s[1].variants[0].body = 'Open to a quick call next week about 30% fewer after-hours calls?'
    expect(lintSequence(s, RULES)).toEqual([])
  })

  it('is off when forbid_yes_no_meeting is false', () => {
    const s = clean()
    s[0].variants[0].body = s[0].variants[0].body.replace('Worth sending over how they did it?', 'Open to a call?')
    expect(lintSequence(s, { ...RULES, step1_cta: { ...RULES.step1_cta, forbid_yes_no_meeting: false } })).toEqual([])
  })
})

describe('formatViolation', () => {
  it('names the rule, step and variant, then the excerpt', () => {
    expect(formatViolation({ rule: 'banned_phrase', step: 2, variant: 'B', message: 'uses "leverage"', excerpt: 'we leverage data' })).toBe(
      'Step 2, variant B — banned_phrase: uses "leverage" (“we leverage data”)'
    )
  })

  it('marks warnings, which never block', () => {
    const w = { rule: 'sequence_structure' as const, step: 1, variant: '', message: 'step 1 has 2 variants; the SOP plans 5', excerpt: '2 variants', severity: 'warning' as const }
    expect(formatViolation(w)).toBe('Step 1 — sequence_structure (warning): step 1 has 2 variants; the SOP plans 5 (“2 variants”)')
    expect(isBlocking(w)).toBe(false)
  })
})

describe('linear trims (no regex backtracking on hostile copy)', () => {
  it('subject word trim and sign-off trim stay fast on long punctuation runs', () => {
    const long = '-'.repeat(60_000)
    const s: LintStep[] = [{ variants: [v(`a${long}a`, `Hi there friend, how are you doing today?\n\nFrank${'.,'.repeat(30_000)}x`)] }]
    const r = { ...RULES, signoff: { '1': 'Frank' } }
    const t = performance.now()
    const out = lintSequence(s, r)
    expect(performance.now() - t).toBeLessThan(500)
    expect(out.map((x) => x.rule)).toContain('signoff')
  })

  it('still trims edge punctuation the same way', () => {
    const s = clean()
    s[0].variants[0].subject = '“after-hours” calls…'
    expect(lintSequence(s, RULES)).toEqual([])
    s[0].variants[0].subject = '“After-hours” calls'
    expect(lintSequence(s, RULES)).toEqual([expect.objectContaining({ rule: 'subject_casing', message: expect.stringContaining('"After-hours"') })])
    const t = clean()
    t[2].variants[0].body = 'Should I close the loop on this, {{firstName}}?\n\nFrank —'
    expect(lintSequence(t, { ...RULES, signoff: { '3': 'Frank' } })).toEqual([])
  })
})

describe('retired {{jurisdiction_line}}', () => {
  it('blocks {{jurisdiction_line}} in a body or subject (any spacing / case): retired, use {{compliance_law}}', () => {
    const s = clean()
    s[1].variants[0].body = '<p>One more thought.</p><p>{{ jurisdiction_line }}</p>'
    s[2].variants[0].subject = 'rules: {{JURISDICTION_LINE}}'
    const out = lintSequence(s, RULES).filter((x) => x.rule === 'retired_variable')
    expect(out.map((x) => [x.step, x.variant, x.message])).toEqual([
      [2, 'A', 'body uses {{jurisdiction_line}}: retired, use {{compliance_law}}'],
      [3, 'A', 'subject uses {{jurisdiction_line}}: retired, use {{compliance_law}}'],
    ])
  })
})

describe('the {{compliance_law}} in HTML', () => {
  const hits = (body: string) => {
    const s = clean()
    s[1].variants[0].body = body
    return lintSequence(s, RULES).filter((x) => x.rule === 'compliance_law_article').length
  }
  it('catches "the" separated by &nbsp;, &#160;, tags or paragraph breaks', () => {
    for (const b of [
      'keeping up with the&nbsp;{{compliance_law}} is a job',
      'keeping up with the&#160;{{compliance_law}} is a job',
      'keeping up with the <b>{{compliance_law}}</b> is a job',
      'keeping up with the <span>{{ compliance_law }}</span> is a job',
      '<p>keeping up with the</p><p>{{compliance_law}} is a job</p>',
      'keeping up with The&NBSP;<i>{{compliance_law}}</i>',
    ]) expect(hits(b), b).toBe(1)
  })
  it('no false positive on a word ending in "the" or a "the" elsewhere', () => {
    for (const b of ['breathe {{compliance_law}}', 'breathe&nbsp;<b>{{compliance_law}}</b>', 'Keeping up with {{compliance_law}} is the job', 'other{{compliance_law}}']) expect(hits(b), b).toBe(0)
  })
})

describe('the {{compliance_law}}', () => {
  it('blocks "the {{compliance_law}}" in a body or subject, any case: the value carries its own article', () => {
    const s = clean()
    s[1].variants[0].body = 'One more thought: keeping up with the {{compliance_law}} is a job.'
    s[2].variants[0].subject = 'THE {{ compliance_law }} changed'
    const out = lintSequence(s, RULES).filter((x) => x.rule === 'compliance_law_article')
    expect(out.map((x) => [x.step, x.variant, x.message])).toEqual([
      [2, 'A', 'body writes "the {{compliance_law}}"; the value already carries its article ("the RTA", "Chapter 83", "local landlord-tenant law"): write {{compliance_law}}'],
      [3, 'A', 'subject writes "the {{compliance_law}}"; the value already carries its article ("the RTA", "Chapter 83", "local landlord-tenant law"): write {{compliance_law}}'],
    ])
  })
  it('leaves {{compliance_law}} alone, and "the" elsewhere in the sentence', () => {
    const s = clean()
    s[1].variants[0].body = 'Keeping up with {{compliance_law}} is the hard part. Breathe {{compliance_law}}.'
    expect(lintSequence(s, RULES).filter((x) => x.rule === 'compliance_law_article')).toEqual([])
  })
})

describe('bare {{jurisdiction}}', () => {
  it('blocks a bare {{jurisdiction}} in a body or subject: use {{compliance_law}}', () => {
    const s = clean()
    s[1].variants[0].body = 'One more thought: in {{ jurisdiction }} the rules changed.'
    s[2].variants[0].subject = 'rules in {{jurisdiction}}'
    const out = lintSequence(s, RULES).filter((x) => x.rule === 'bare_jurisdiction')
    expect(out.map((x) => [x.step, x.variant, x.message])).toEqual([
      [2, 'A', 'body uses {{jurisdiction}}; use {{compliance_law}}'],
      [3, 'A', 'subject uses {{jurisdiction}}; use {{compliance_law}}'],
    ])
    expect(out.every(isBlocking)).toBe(true)
  })

  it('leaves {{compliance_law}} and the word "jurisdiction" alone', () => {
    const s = clean()
    s[1].variants[0].body = 'One more thought: keeping up with {{compliance_law}} is a job. Every jurisdiction differs. The rules change.'
    expect(lintSequence(s, RULES).filter((x) => x.rule === 'bare_jurisdiction')).toEqual([])
  })
})
