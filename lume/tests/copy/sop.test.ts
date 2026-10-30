import { describe, expect, it } from 'vitest'
import { loadSop, parseSop, SopError, sopPromptBlock } from '@/lib/copy/sop'

const RULES = `version: 1
placeholder: false
banned_phrases: [just checking in]
word_count:
  step1: { min: 10, max: 100 }
  followup: { min: 5, max: 60 }
subject:
  casing: lowercase
  max_words: 5
proof_points:
  - id: acme
    patterns: [Acme Property Group]
personalization_fields: [hook, city]
max_personalization_fields_per_email: 1
step1_cta:
  forbid_yes_no_meeting: true
  meeting_words: [call, demo]
fallbacks:
  open_role: a
  door_count: b
  pms: c
  jurisdiction: d
  generic: e
`
const doc = (rules: string, prose = '## Voice\n\nPlain.\n') => `---\n${rules}---\n\n${prose}`

describe('parseSop', () => {
  it('splits the front matter from the prose and parses the rules', () => {
    const sop = parseSop(doc(RULES))
    expect(sop.rules.banned_phrases).toEqual(['just checking in'])
    expect(sop.rules.word_count.step1).toEqual({ min: 10, max: 100 })
    expect(sop.rules.subject).toEqual({ casing: 'lowercase', max_words: 5, allowed_capitalized: [] })
    expect(sop.rules.proof_points[0]).toEqual({ id: 'acme', patterns: ['Acme Property Group'] })
    expect(sop.rules.fallbacks.generic).toBe('e')
    expect(sop.prose).toBe('## Voice\n\nPlain.')
  })

  it('accepts CRLF line endings', () => {
    expect(parseSop(doc(RULES).replace(/\n/g, '\r\n')).rules.version).toBe(1)
  })

  const bad: [string, string][] = [
    ['no front matter', '## Voice\n'],
    ['an unclosed front matter block', `---\n${RULES}\n## Voice`],
    ['invalid YAML', doc('banned_phrases: [unclosed\n')],
    ['an unknown key (a typo)', doc(`${RULES}banned_phrase: [x]\n`)],
    ['a missing section', doc(RULES.replace(/fallbacks:[\s\S]*$/, ''))],
    ['a missing fallback field', doc(RULES.replace('  pms: c\n', ''))],
    ['min above max', doc(RULES.replace('{ min: 10, max: 100 }', '{ min: 200, max: 100 }'))],
    ['an unknown subject casing', doc(RULES.replace('casing: lowercase', 'casing: shouty'))],
    ['a duplicate proof point id', doc(RULES.replace('    patterns: [Acme Property Group]\n', '    patterns: [Acme]\n  - id: acme\n    patterns: [Acme 2]\n'))],
    ['a proof point without patterns', doc(RULES.replace('[Acme Property Group]', '[]'))],
    ['an empty banned phrase', doc(RULES.replace('[just checking in]', "['  ']"))],
    ['a string where a number belongs', doc(RULES.replace('max_words: 5', 'max_words: five'))],
  ]
  it.each(bad)('fails loudly on %s', (_name, text) => {
    expect(() => parseSop(text)).toThrow(SopError)
  })
})

describe('the committed SOP (lume/sops/cold-email-sop.md)', () => {
  it('parses: a malformed SOP fails this test, the build and every sequence edit', () => {
    const sop = loadSop()
    expect(sop.rules.version).toBe(1)
    expect(sop.rules.personalization_fields.length).toBeGreaterThan(0)
    for (const f of ['open_role', 'door_count', 'pms', 'jurisdiction', 'generic'] as const) expect(sop.rules.fallbacks[f].trim()).not.toBe('')
    expect(sop.prose).toMatch(/## Voice/)
    expect(sop.prose).toMatch(/## Fallback sentences/)
  })

  it('renders a stable prompt block with the rules summary and the prose', () => {
    const sop = loadSop()
    const block = sopPromptBlock(sop)
    expect(block).toBe(sopPromptBlock(loadSop()))
    expect(block).toMatch(/Cold-email SOP/)
    expect(block).toMatch(/Banned phrases \(never in a subject or body\):/)
    expect(block).toMatch(/at most 1 personalization variable/)
    expect(block).toMatch(/Fallback sentences/)
    expect(block).toContain(sop.prose)
  })
})
