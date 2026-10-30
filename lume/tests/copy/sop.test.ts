import { describe, expect, it } from 'vitest'
import {
  buildSopLibrary,
  clientForCampaign,
  clientForContext,
  findClient,
  loadSop,
  loadSopLibrary,
  parseSop,
  SopError,
  sopForCampaign,
  sopPromptBlock,
} from '@/lib/copy/sop'

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
    expect(sop.rules.subject).toEqual({ casing: 'lowercase', min_words: 0, max_words: 5, allowed_capitalized: [], no_company: false, forbid: [] })
    expect(sop.rules.no_exclamation).toBe(false)
    expect(sop.rules.max_proof_points_per_email).toBeNull()
    expect(sop.rules.sequence).toBeNull()
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
    ['an invalid proof point regex', doc(RULES.replace('[Acme Property Group]', "['(unclosed']"))],
    ['a step rule keyed by a non-number', doc(`${RULES}step_rules:\n  last:\n    forbid: [x]\n`)],
  ]
  it.each(bad)('fails loudly on %s', (_name, text) => {
    expect(() => parseSop(text)).toThrow(SopError)
  })
})

const OVERLAY = (extra = '') => `---
version: 1
client: acme
name: Acme
match:
  campaign_names: [acme, roadrunner]
banned_phrases: [synergy, Just Checking In]
no_exclamation: true
subject:
  max_words: 3
word_count:
  followup: { min: 1, max: 40 }
proof_points:
  - id: acme_case
    patterns: ['\\bacme case\\b']
max_proof_points_per_email: 1
signoff:
  "1": Wile E
fallbacks:
  generic: acme generic
  after_hours: acme nights
${extra}---

## Acme voice

Dry.
`

describe('client overlays', () => {
  const lib = () => buildSopLibrary(doc(RULES), [{ file: 'acme.md', raw: OVERLAY() }])

  it('merges onto the base: banned phrases extend, sections merge key by key, other keys replace', () => {
    const acme = findClient(lib(), 'acme')!
    expect(acme.prose).toBe('## Acme voice\n\nDry.')
    const r = acme.rules
    expect(r.banned_phrases).toEqual(['just checking in', 'synergy'])
    expect(r.no_exclamation).toBe(true)
    expect(r.subject).toMatchObject({ casing: 'lowercase', max_words: 3 })
    expect(r.word_count).toEqual({ step1: { min: 10, max: 100 }, followup: { min: 1, max: 40 } })
    expect(r.proof_points.map((p) => p.id)).toEqual(['acme_case'])
    expect(r.max_proof_points_per_email).toBe(1)
    expect(r.signoff).toEqual({ '1': 'Wile E' })
    expect(r.fallbacks).toMatchObject({ generic: 'acme generic', pms: 'c', after_hours: 'acme nights' })
    expect(r.personalization_fields).toEqual(['hook', 'city'])
  })

  it('picks the overlay for a campaign by name (contains, case-insensitive) or id, else the base', () => {
    const l = lib()
    expect(clientForCampaign(l, { name: 'ACME — fall push' })?.client).toBe('acme')
    expect(clientForCampaign(l, { name: 'Roadrunner 2' })?.client).toBe('acme')
    expect(clientForCampaign(l, { name: 'Other' })).toBeNull()
    expect(sopForCampaign({ name: 'Other' }, l)).toEqual({ rules: l.base.rules, client: null })
    expect(sopForCampaign({ name: 'acme' }, l).client).toBe('acme')
    const byId = buildSopLibrary(doc(RULES), [{ file: 'acme.md', raw: OVERLAY().replace('campaign_names: [acme, roadrunner]', 'campaign_ids: [c-123]') }])
    expect(clientForCampaign(byId, { id: 'c-123', name: 'x' })?.client).toBe('acme')
  })

  it('refuses a campaign two overlays both match', () => {
    const two = buildSopLibrary(doc(RULES), [
      { file: 'acme.md', raw: OVERLAY() },
      { file: 'beta.md', raw: OVERLAY().replace('client: acme', 'client: beta').replace('name: Acme', 'name: Beta') },
    ])
    expect(() => clientForCampaign(two, { name: 'acme 1' })).toThrow(/more than one client SOP/)
  })

  it('picks the overlay for an agent chat from its vertical or project name', () => {
    const l = lib()
    expect(clientForContext(l, { vertical: 'Acme' })?.client).toBe('acme')
    expect(clientForContext(l, { project: 'Roadrunner launch' })?.client).toBe('acme')
    expect(clientForContext(l, { vertical: 'Other', project: null })).toBeNull()
    expect(clientForContext(l, {})).toBeNull()
  })

  const badOverlays: [string, string, string][] = [
    ['a file name that is not the client id', 'wrong.md', OVERLAY()],
    ['no match block', 'acme.md', OVERLAY().replace(/match:\n {2}campaign_names: \[acme, roadrunner\]\n/, '')],
    ['an empty match', 'acme.md', OVERLAY().replace('campaign_names: [acme, roadrunner]', 'campaign_names: []')],
    ['an unknown key', 'acme.md', OVERLAY('signof: {}\n')],
    ['a merge that breaks a range', 'acme.md', OVERLAY().replace('{ min: 1, max: 40 }', '{ min: 50 }')],
  ]
  it.each(badOverlays)('fails loudly on an overlay with %s', (_n, file, raw) => {
    expect(() => buildSopLibrary(doc(RULES), [{ file, raw }])).toThrow(SopError)
  })

  it('prompt block: base + the chat client, or the list of overlays and get_sop', () => {
    const l = lib()
    const withClient = sopPromptBlock(l, findClient(l, 'acme'))
    expect(withClient).toMatch(/Base SOP text:\n## Voice/)
    expect(withClient).toMatch(/Client SOP: Acme \(client id acme; applies to campaigns whose name contains "acme", "roadrunner"\)/)
    expect(withClient).toMatch(/## Acme voice/)
    expect(withClient).toMatch(/No exclamation marks/)
    const index = sopPromptBlock(l)
    expect(index).not.toMatch(/## Acme voice/)
    expect(index).toMatch(/- acme: Acme; campaigns whose name contains/)
    expect(index).toMatch(/call get_sop/)
    expect(sopPromptBlock(l)).toBe(index)
  })
})

describe('the committed SOPs (lume/sops)', () => {
  it('parse: a malformed SOP fails this test, the build and every sequence edit', () => {
    const sop = loadSop()
    expect(sop.rules.version).toBe(1)
    expect(sop.rules.personalization_fields.length).toBeGreaterThan(0)
    for (const f of ['open_role', 'door_count', 'pms', 'jurisdiction', 'generic'] as const) expect(sop.rules.fallbacks[f].trim()).not.toBe('')
    expect(sop.prose).toMatch(/## Voice/)
    expect(sop.prose).toMatch(/## Fallback sentences/)
  })

  it('Kaspen matches its Zenport campaign and carries its real rules', () => {
    const lib = loadSopLibrary()
    expect(lib.clients.map((c) => c.client)).toContain('kaspen')
    expect(sopForCampaign({ name: 'Zenport - Oct' }, lib).client).toBe('kaspen')
    expect(sopForCampaign({ name: 'Kaspen PM owners' }, lib).client).toBe('kaspen')
    const k = findClient(lib, 'kaspen')!
    expect(k.rules.placeholder).toBe(false)
    expect(k.rules.proof_points).toHaveLength(7)
    expect(k.rules.subject).toMatchObject({ casing: 'lowercase', min_words: 2, max_words: 4, no_company: true })
    expect(k.rules.word_count).toEqual({ step1: { min: 60, max: 90 }, followup: { min: 1, max: 59 } })
    expect(k.rules.banned_phrases).toEqual(expect.arrayContaining(["I'd love to", 'reach out', 'solution', 'any thoughts', 'I wanted to']))
    expect(k.rules.only_in_step).toEqual({ Vancouver: [1] })
    expect(k.rules.signoff).toEqual({ '1': 'Frank Jing', '2': 'Frank', '3': 'Frank', '4': 'Frank Jing' })
    expect(k.prose).toMatch(/## Do not repeat these mistakes/)
    expect(k.prose).toMatch(/## Reply handling/)
    expect(k.prose).toMatch(/## Test plan/)
  })

  it('renders a stable prompt block with the rules summary and the prose', () => {
    const lib = loadSopLibrary()
    const block = sopPromptBlock(lib)
    expect(block).toBe(sopPromptBlock(loadSopLibrary()))
    expect(block).toMatch(/Cold-email SOP/)
    expect(block).toMatch(/Banned phrases \(never in a subject or body\):/)
    expect(block).toMatch(/at most 1 per email/)
    expect(block).toMatch(/Fallback sentences/)
    expect(block).toContain(lib.base.prose)
    expect(block).toMatch(/- kaspen: Kaspen/)
  })
})
