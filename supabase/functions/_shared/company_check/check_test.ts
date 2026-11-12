// Run: deno test _shared/company_check/
import { assertEquals, assertThrows } from 'jsr:@std/assert@1'
import {
  CHECK_USD_PER_COMPANY,
  checkParseRequest,
  checkQuestion,
  groundCheck,
  haikuCeilingUsd,
  HAIKU_MODEL,
  PARSE_MAX_TOKENS,
  PARSE_USER_MAX_CHARS,
  parseCheckJson,
} from './check.ts'
import { HAIKU_IN_PER_M, HAIKU_OUT_PER_M, PPLX_CALL_USD } from '../influencer/cost.ts'

const ICP = 'a property management company that actively manages properties'
const C = { company_name: 'Acme Property Management', website: 'https://www.acmepm.com', company_key: 'acmepm.com' }

Deno.test('price: Perplexity call + the Haiku ceiling, rounded up to $0.00001', () => {
  const haiku = haikuCeilingUsd()
  assertEquals(haiku > 0 && haiku < 0.002, true)
  assertEquals(CHECK_USD_PER_COMPANY >= PPLX_CALL_USD + haiku, true)
  assertEquals(CHECK_USD_PER_COMPANY - (PPLX_CALL_USD + haiku) < 0.00001, true)
  // The ceiling uses the full output budget at the output price.
  assertEquals(haiku >= PARSE_MAX_TOKENS * HAIKU_OUT_PER_M / 1e6 + PARSE_USER_MAX_CHARS * HAIKU_IN_PER_M / 1e6, true)
  assertEquals(CHECK_USD_PER_COMPANY, 0.00695)
})

Deno.test('checkQuestion: names the company, its site and the ICP; a name-only key uses the name', () => {
  const q = checkQuestion(C, ICP)
  for (const s of ['Acme Property Management', 'acmepm.com', ICP, 'cannot find']) assertEquals(q.includes(s), true, s)
  const n = checkQuestion({ company_name: null, website: null, company_key: 'name:acme co' }, ICP)
  assertEquals(n.includes('"acme co"'), true)
  assertEquals(n.includes('website'), false)
})

Deno.test('checkParseRequest: Haiku JSON request, user message clipped to the ceiling the price assumes', () => {
  const r = checkParseRequest(C, ICP, 'x'.repeat(20_000), ['https://acmepm.com/about'])
  assertEquals(r.model, HAIKU_MODEL)
  assertEquals(r.max_tokens, PARSE_MAX_TOKENS)
  assertEquals(r.messages[0].content.length <= PARSE_USER_MAX_CHARS, true)
  assertEquals(r.messages[0].content.includes('[1] https://acmepm.com/about'), true)
})

Deno.test('parseCheckJson: strict enums, what_it_does required', () => {
  const ok = parseCheckJson({ what_it_does: 'Manages rentals.', icp_fit: 'fit', confidence: 'high', evidence: 'We manage 400 doors', evidence_url: 'https://a.com' })
  assertEquals([ok.icp_fit, ok.confidence, ok.evidence_url], ['fit', 'high', 'https://a.com'])
  assertEquals(parseCheckJson({ what_it_does: 'x', icp_fit: 'unclear', confidence: 'low', evidence: '', evidence_url: '' }).evidence_url, null)
  assertThrows(() => parseCheckJson({ what_it_does: 'x', icp_fit: 'maybe', confidence: 'low' }))
  assertThrows(() => parseCheckJson({ what_it_does: 'x', icp_fit: 'fit', confidence: 'sure' }))
  assertThrows(() => parseCheckJson({ what_it_does: '', icp_fit: 'fit', confidence: 'low' }))
  assertThrows(() => parseCheckJson(null))
})

Deno.test('groundCheck: uncited evidence URL dropped (high -> medium); no citations -> low', () => {
  const r = { what_it_does: 'x', icp_fit: 'fit' as const, confidence: 'high' as const, evidence: 'e', evidence_url: 'https://made-up.com' }
  assertEquals(groundCheck(r, ['https://a.com']), { ...r, evidence_url: null, confidence: 'medium' })
  assertEquals(groundCheck({ ...r, evidence_url: 'https://a.com' }, ['https://a.com']).confidence, 'high')
  assertEquals(groundCheck(r, []), { ...r, evidence_url: null, confidence: 'low' })
})
