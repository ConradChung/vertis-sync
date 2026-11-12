// Run: deno test _shared/company_check/
import { assertEquals, assertThrows } from 'jsr:@std/assert@1'
import {
  CHECK_USD_PER_COMPANY,
  checkParseRequest,
  checkQuestion,
  checkRequest,
  groundCheck,
  haikuCeilingUsd,
  HAIKU_MODEL,
  PARSE_MAX_TOKENS,
  PARSE_USER_MAX_CHARS,
  PARSE_SCHEMA,
  PARSE_SYSTEM,
  parseCheckJson,
  PROPERTY_TYPES,
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
  assertEquals(CHECK_USD_PER_COMPANY, 0.00706)
})

Deno.test('checkQuestion: names the company, its site and the ICP; a name-only key uses the name', () => {
  const q = checkQuestion(C, ICP)
  for (const s of ['Acme Property Management', 'acmepm.com', ICP, 'cannot find', 'doors', 'multifamily', 'commercial', 'single-family']) assertEquals(q.includes(s), true, s)
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

Deno.test('checkRequest: still ONE Perplexity request of the verify shape (the price assumes it)', () => {
  const r = checkRequest(C, ICP)
  assertEquals(r.model, 'sonar')
  assertEquals(r.max_tokens, 600)
  assertEquals(r.web_search_options.search_context_size, 'low')
  assertEquals(r.messages.length, 1)
})

Deno.test('PARSE_SCHEMA / PARSE_SYSTEM: property_type enum, doors, doors_evidence; icp_fit follows the ICP exclusions', () => {
  const props = PARSE_SCHEMA.properties as Record<string, { enum?: string[]; type: string }>
  assertEquals(props.property_type.enum, [...PROPERTY_TYPES])
  assertEquals(props.doors.type, 'integer')
  for (const k of ['property_type', 'doors', 'doors_evidence']) assertEquals(PARSE_SCHEMA.required.includes(k), true, k)
  for (const s of ['EXACTLY as written', '"multifamily"', '"mixed"', '0 if unknown']) assertEquals(PARSE_SYSTEM.includes(s), true, s)
})

Deno.test('parseCheckJson: strict enums, what_it_does required', () => {
  const ok = parseCheckJson({ what_it_does: 'Manages rentals.', icp_fit: 'fit', confidence: 'high', evidence: 'We manage 400 doors', evidence_url: 'https://a.com', property_type: 'residential', doors: 400, doors_evidence: '400 doors (site)' })
  assertEquals([ok.icp_fit, ok.confidence, ok.evidence_url, ok.property_type, ok.doors, ok.doors_evidence], ['fit', 'high', 'https://a.com', 'residential', 400, '400 doors (site)'])
  const thin = parseCheckJson({ what_it_does: 'x', icp_fit: 'unclear', confidence: 'low', evidence: '', evidence_url: '', property_type: 'unknown', doors: 0, doors_evidence: 'n/a' })
  assertEquals([thin.evidence_url, thin.doors, thin.doors_evidence], [null, null, ''])
  // A missing property_type (older shape) is unknown; nonsense door counts are unknown.
  assertEquals(parseCheckJson({ what_it_does: 'x', icp_fit: 'fit', confidence: 'low' }).property_type, 'unknown')
  assertEquals(parseCheckJson({ what_it_does: 'x', icp_fit: 'fit', confidence: 'low', doors: -5 }).doors, null)
  assertEquals(parseCheckJson({ what_it_does: 'x', icp_fit: 'fit', confidence: 'low', doors: 5_000_000 }).doors, null)
  assertEquals(parseCheckJson({ what_it_does: 'x', icp_fit: 'fit', confidence: 'low', doors: 12.7 }).doors, 12)
  assertThrows(() => parseCheckJson({ what_it_does: 'x', icp_fit: 'fit', confidence: 'low', property_type: 'industrial' }))
  assertThrows(() => parseCheckJson({ what_it_does: 'x', icp_fit: 'maybe', confidence: 'low' }))
  assertThrows(() => parseCheckJson({ what_it_does: 'x', icp_fit: 'fit', confidence: 'sure' }))
  assertThrows(() => parseCheckJson({ what_it_does: '', icp_fit: 'fit', confidence: 'low' }))
  assertThrows(() => parseCheckJson(null))
})

Deno.test('groundCheck: uncited evidence URL dropped (high -> medium); no citations -> low', () => {
  const r = { what_it_does: 'x', icp_fit: 'fit' as const, confidence: 'high' as const, evidence: 'e', evidence_url: 'https://made-up.com', property_type: 'residential' as const, doors: 10, doors_evidence: '10 doors' }
  assertEquals(groundCheck(r, ['https://a.com']), { ...r, evidence_url: null, confidence: 'medium' })
  assertEquals(groundCheck({ ...r, evidence_url: 'https://a.com' }, ['https://a.com']).confidence, 'high')
  assertEquals(groundCheck(r, []), { ...r, evidence_url: null, confidence: 'low' })
})
