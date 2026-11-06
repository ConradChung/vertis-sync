// Run: deno test _shared/influencer/
import { assertEquals, assertThrows } from 'jsr:@std/assert@1'
import {
  groundLookup,
  LOOKUP_USD_PER_PERSON,
  lookupParseRequest,
  lookupQuestion,
  normalizeLinkedinUrl,
  parseLookupJson,
  parseLookupResponse,
  type LookupCandidate,
} from './lookup.ts'

const C: LookupCandidate = { name: 'Sarah Johnson', title: 'Director of Property Management', company: 'Greystar Real Estate Partners' }

Deno.test('normalizeLinkedinUrl: any linkedin.com/in URL -> https://www.linkedin.com/in/<slug>, else null', () => {
  assertEquals(normalizeLinkedinUrl('http://ca.linkedin.com/in/Sarah-Johnson-12ab/?trk=x'), 'https://www.linkedin.com/in/sarah-johnson-12ab')
  assertEquals(normalizeLinkedinUrl('https://linkedin.com/in/sjohnson'), 'https://www.linkedin.com/in/sjohnson')
  assertEquals(normalizeLinkedinUrl('https://www.linkedin.com/in/sjohnson/details/experience'), 'https://www.linkedin.com/in/sjohnson')
  for (const bad of ['https://www.linkedin.com/company/greystar', 'https://www.linkedin.com/pub/dir/sarah', 'https://evil.com/in/x', 'linkedin.com/in/', '', 'https://www.linkedin.com.evil.com/in/x']) {
    assertEquals(normalizeLinkedinUrl(bad), null, bad)
  }
})

Deno.test('lookupQuestion: asks for the linkedin.com/in profile by name, title and company, citing the profile', () => {
  const q = lookupQuestion(C)
  for (const s of ['Sarah Johnson', 'Director of Property Management', 'Greystar Real Estate Partners', 'linkedin.com/in/']) assertEquals(q.includes(s), true, s)
})

Deno.test('parseLookupResponse: answer, citations and search_results (url, title, snippet), cost from usage', () => {
  const r = parseLookupResponse({
    choices: [{ message: { content: 'Her profile is https://www.linkedin.com/in/made-up [1]' } }],
    citations: ['https://www.linkedin.com/in/sarah-johnson-12ab'],
    search_results: [{ url: 'https://www.linkedin.com/in/sarah-johnson-12ab', title: 'Sarah Johnson - Director of Property Management - Greystar', snippet: 'Greystar | LinkedIn' }],
    usage: { cost: { total_cost: 0.0061 } },
  })
  assertEquals(r.cost, 0.0061)
  assertEquals(r.sources, [{ url: 'https://www.linkedin.com/in/sarah-johnson-12ab', title: 'Sarah Johnson - Director of Property Management - Greystar', snippet: 'Greystar | LinkedIn' }])
})

const src = (url: string, title = '', snippet = '') => ({ url, title, snippet })
const parsed = (o: Record<string, unknown> = {}) => parseLookupJson({ linkedin_url: '', evidence_url: '', evidence_quote: '', reason: 'r', ...o })

Deno.test('groundLookup: a URL the model typed without a citation is never accepted', () => {
  const sources = [src('https://www.greystar.com/team', 'Greystar team', 'Sarah Johnson, Director of Property Management')]
  const g = groundLookup(C, parsed({ linkedin_url: 'https://www.linkedin.com/in/made-up' }), sources)
  assertEquals([g.status, g.confidence, g.linkedin_url], ['not_found', 'not_found', null])
})

Deno.test('groundLookup: high when the cited LinkedIn result names the person and the company', () => {
  const sources = [src('https://ca.linkedin.com/in/Sarah-Johnson-12ab', 'Sarah Johnson - Director of Property Management - Greystar', 'Greystar Real Estate Partners')]
  const g = groundLookup(C, parsed({ linkedin_url: 'https://ca.linkedin.com/in/Sarah-Johnson-12ab' }), sources)
  assertEquals([g.status, g.confidence, g.linkedin_url], ['found', 'high', 'https://www.linkedin.com/in/sarah-johnson-12ab'])
  assertEquals(g.evidence, { url: 'https://ca.linkedin.com/in/Sarah-Johnson-12ab', snippet: 'Sarah Johnson - Director of Property Management - Greystar · Greystar Real Estate Partners' })
})

Deno.test('groundLookup: medium when only the role ties it, or the tie is in a cited quote rather than the result itself', () => {
  const role = [src('https://www.linkedin.com/in/sjohnson', 'Sarah Johnson - Director of Property Management', '')]
  assertEquals(groundLookup(C, parsed({ linkedin_url: 'https://www.linkedin.com/in/sjohnson' }), role).confidence, 'medium')
  const viaQuote = [src('https://www.linkedin.com/in/sjohnson', 'Sarah Johnson | LinkedIn', ''), src('https://www.greystar.com/team', 'Team', '')]
  // The quote is taken from the answer text Perplexity wrote with that citation.
  const answer = 'Sarah Johnson leads property management at Greystar [2]; her profile is linkedin.com/in/sjohnson [1].'
  const g = groundLookup(C, parsed({ linkedin_url: 'https://www.linkedin.com/in/sjohnson', evidence_url: 'https://www.greystar.com/team', evidence_quote: 'Sarah Johnson leads property management at Greystar' }), viaQuote, answer)
  assertEquals([g.confidence, g.evidence?.url], ['medium', 'https://www.greystar.com/team'])
  // ...or from the cited source's own title / snippet.
  const inSnippet = [src('https://www.linkedin.com/in/sjohnson', 'Sarah Johnson | LinkedIn', ''), src('https://www.greystar.com/team', 'Team', 'Sarah Johnson, Greystar regional lead')]
  assertEquals(groundLookup(C, parsed({ linkedin_url: 'https://www.linkedin.com/in/sjohnson', evidence_url: 'https://www.greystar.com/team', evidence_quote: 'Sarah Johnson, Greystar' }), inSnippet, '').confidence, 'medium')
})

Deno.test('groundLookup: a cited URL with no tie to the company or role, or the wrong name, is not_found', () => {
  const noTie = [src('https://www.linkedin.com/in/sjohnson', 'Sarah Johnson - Yoga teacher', 'Portland')]
  assertEquals(groundLookup(C, parsed({ linkedin_url: 'https://www.linkedin.com/in/sjohnson' }), noTie).status, 'not_found')
  const wrongName = [src('https://www.linkedin.com/in/mike-lee', 'Mike Lee - Greystar', 'Director of Property Management')]
  assertEquals(groundLookup(C, parsed({ linkedin_url: 'https://www.linkedin.com/in/mike-lee' }), wrongName).status, 'not_found')
  // A quote from a source that was NOT cited never counts.
  const g = groundLookup(C, parsed({ linkedin_url: 'https://www.linkedin.com/in/sjohnson', evidence_url: 'https://uncited.com', evidence_quote: 'Sarah Johnson at Greystar' }), [src('https://www.linkedin.com/in/sjohnson', 'Sarah Johnson | LinkedIn')])
  assertEquals(g.status, 'not_found')
})

Deno.test('groundLookup: an invented quote attached to a cited namesake URL is not_found (the quote must be in the source or the answer)', () => {
  const sources = [src('https://www.linkedin.com/in/sjohnson', 'Sarah Johnson | LinkedIn', 'Yoga teacher, Portland'), src('https://www.greystar.com/team', 'Our team', 'Meet the leasing staff')]
  const g = groundLookup(
    C,
    parsed({ linkedin_url: 'https://www.linkedin.com/in/sjohnson', evidence_url: 'https://www.greystar.com/team', evidence_quote: 'Sarah Johnson is Director of Property Management at Greystar' }),
    sources,
    'I found a Sarah Johnson on LinkedIn [1] and a Greystar team page [2].',
  )
  assertEquals([g.status, g.confidence, g.linkedin_url], ['not_found', 'not_found', null])
})

Deno.test('lookupParseRequest: Haiku JSON with the numbered sources; parseLookupJson validates', () => {
  const req = lookupParseRequest(C, 'answer', [src('https://www.linkedin.com/in/x', 'T', 'S')])
  assertEquals(req.output_config.format.type, 'json_schema')
  assertEquals(req.messages[0].content.includes('[1] https://www.linkedin.com/in/x — T — S'), true)
  assertThrows(() => parseLookupJson({ linkedin_url: 1 }))
})

Deno.test('LOOKUP_USD_PER_PERSON: one Sonar call plus the Haiku parse', () => {
  assertEquals(LOOKUP_USD_PER_PERSON, 0.0065)
})
