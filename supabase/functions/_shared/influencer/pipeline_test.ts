// Run: deno test _shared/influencer/
// Ports ~/Downloads/pm-reactions-pipeline/tests (test_posts, test_reactions,
// test_triage, test_verify, test_pipeline) and their fixtures.
import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@1'
import {
  apifyActualUsd,
  haikuUsd,
  postsReserveUsd,
  reactionsMaxChargeUsd,
  estimateReactions,
  PRICE_PER_1K_POSTS,
  PRICE_PER_1K_REACTIONS,
} from './cost.ts'
import { buildPostsInput, flattenPosts, relevanceRequest, parseRelevance, topN, applyRelevance } from './posts.ts'
import { aggregateReactors, buildReactionsInput, flattenReactions } from './reactions.ts'
import { parseTriage, triageRequest, triageTodo } from './triage.ts'
import {
  doorQuestion,
  doorRetryTodo,
  groundDoorCount,
  parsePerplexity,
  parseVerifyJson,
  perplexityRequest,
  retryable,
  verdict,
  verificationQuestion,
  verifyParseRequest,
  verifyTodo,
} from './verify.ts'
import { buildJsonRequest, parseJsonResponse, HAIKU_MODEL } from './haiku.ts'

import postsSample from './fixtures/posts_sample.json' with { type: 'json' }
import reactionsSample from './fixtures/reactions_sample.json' with { type: 'json' }

// ---------------------------------------------------------------------------
// cost

Deno.test('reactions estimate: likes capped per post, $1.5 per 1k (test_pipeline)', () => {
  assertEquals(estimateReactions([{ likes: 1500 }, { likes: 200 }, { likes: 0 }], 1000), { reactions: 1200, usd: 1.8 })
  assertEquals(estimateReactions([{ likes: 1500 }], 0).reactions, 1500)
  assertEquals(PRICE_PER_1K_REACTIONS, 1.5)
  assertEquals(PRICE_PER_1K_POSTS, 2)
})

Deno.test('reactions max charge: 10% + 5 cents headroom, rounded up to the cent, at most $20', () => {
  assertEquals(reactionsMaxChargeUsd(1.8), 2.03)
  assertEquals(reactionsMaxChargeUsd(0), 0.05)
  assertEquals(reactionsMaxChargeUsd(30), 20)
})

Deno.test('posts reserve: 1.5x last run posts at $2/1k + 10 cents; unknown -> 300 posts; at most $20', () => {
  assertEquals(postsReserveUsd(317), 1.06)
  assertEquals(postsReserveUsd(null), 1)
  assertEquals(postsReserveUsd(0), 0.1)
  assertEquals(postsReserveUsd(100_000), 20)
})

Deno.test('apify actual cost: the larger of usageTotalUsd and items x unit price', () => {
  assertEquals(apifyActualUsd({ usageTotalUsd: 0.01 }, 1114, PRICE_PER_1K_REACTIONS), 1.671)
  assertEquals(apifyActualUsd({ usageTotalUsd: 3 }, 10, PRICE_PER_1K_REACTIONS), 3)
  assertEquals(apifyActualUsd({}, 0, PRICE_PER_1K_POSTS), 0)
})

Deno.test('haiku cost from usage: $0.10 / $0.50 per million tokens', () => {
  assertEquals(haikuUsd({ input_tokens: 1_000_000, output_tokens: 1_000_000 }), 0.6)
  assertEquals(haikuUsd(null), 0)
})

// ---------------------------------------------------------------------------
// posts (test_posts)

Deno.test('posts input: lookback date, no reposts, no reactions/comments scraped', () => {
  const inp = buildPostsInput('https://www.linkedin.com/in/pslohmann', 90, new Date('2026-10-30T00:00:00Z'))
  assertEquals(inp, {
    targetUrls: ['https://www.linkedin.com/in/pslohmann'],
    maxPosts: 0,
    postedLimitDate: '2026-08-01',
    includeReposts: false,
    includeQuotePosts: true,
    scrapeReactions: false,
    scrapeComments: false,
  })
})

Deno.test('flattenPosts extracts the expected columns and skips non-posts', () => {
  const rows = flattenPosts(postsSample)
  assertEquals(rows.length, 3)
  assertEquals(rows[0].post_id, '111')
  assert(rows[0].post_url.endsWith('activity-111'))
  assertEquals(rows[0].posted_at, '2026-09-04T00:00:00.000Z')
  assertEquals(rows[0].likes, 320)
  assertEquals(rows[0].comments, 40)
  assert(rows[0].text.startsWith('Three things'))
  assertEquals(flattenPosts([{ type: 'repost', id: '9' }]), [])
  assertEquals(flattenPosts([{ type: 'post', id: '', linkedinUrl: 'u' }, null, 'x']), [])
})

Deno.test('relevance request: Haiku, one <post> block per post, structured output schema', () => {
  const req = relevanceRequest([{ post_id: '111', text: 'a"b' }, { post_id: '222', text: 'x'.repeat(5000) }])
  assertEquals(req.model, HAIKU_MODEL)
  const user = req.messages[0].content
  assert(user.includes('<post id="111">'))
  assert(!user.includes('x'.repeat(1501)), 'text is cut at 1500 chars')
  assertEquals((req.output_config.format as { type: string }).type, 'json_schema')
})

Deno.test('parseRelevance maps ids to labels; a missing id is not relevant', () => {
  const labels = parseRelevance({ results: [{ post_id: '111', pm_relevant: true, reason: 'r' }] })
  assertEquals(applyRelevance([{ post_id: '111' }, { post_id: '222' }], labels), [
    { post_id: '111', pm_relevant: true, relevance_reason: 'r' },
    { post_id: '222', pm_relevant: false, relevance_reason: 'no label returned' },
  ])
  assertThrows(() => parseRelevance({ nope: 1 }))
})

Deno.test('topN keeps only relevant posts, sorted by likes, ranked from 1', () => {
  const out = topN([
    { post_id: '1', pm_relevant: true, likes: 10 },
    { post_id: '2', pm_relevant: false, likes: 999 },
    { post_id: '3', pm_relevant: true, likes: 50 },
    { post_id: '4', pm_relevant: true, likes: 30 },
  ], 2)
  assertEquals(out.map((r) => r.post_id), ['3', '4'])
  assertEquals(out.map((r) => r.rank), [1, 2])
})

// ---------------------------------------------------------------------------
// reactions (test_reactions)

Deno.test('reactions input uses post URLs and the per-post cap', () => {
  assertEquals(buildReactionsInput(['u1', 'u2'], 500), { posts: ['u1', 'u2'], maxItems: 500, profileScraperMode: 'short' })
})

Deno.test('flattenReactions joins on the query.post URL', () => {
  const rows = flattenReactions(reactionsSample, { '111': 'https://x/111', '333': 'https://x/333' })
  assertEquals(rows.length, 3)
  assertEquals(rows[0], {
    post_id: '111', post_url: 'https://x/111', reaction_type: 'LIKE', reactor_id: 'AAA',
    reactor_name: 'Alice Owner', reactor_url: 'https://www.linkedin.com/in/AAA',
    reactor_headline: 'Owner, Acme Property Management | 450 doors',
  })
})

Deno.test('flattenReactions skips empty actors, strips URNs, prefers the query URL', () => {
  const rows = flattenReactions([
    { actor: { id: 'AAA', name: 'Alice' }, postId: '1', reactionType: 'LIKE' },
    { actor: { id: '', name: 'Ghost' }, postId: '1' },
    { actor: {}, postId: '1' },
    { postId: '1' },
    { reactionType: 'LIKE', postId: 'urn:li:ugcPost:999', actor: { id: 'Z', name: 'z', linkedinUrl: 'u', position: 'p' }, query: { post: 'https://x/999' } },
    { reactionType: 'LIKE', postId: 'urn:li:ugcPost:777', actor: { id: 'Y', name: 'y', linkedinUrl: 'u', position: 'p' }, query: { post: 'https://x/111' } },
  ], { '999': 'https://x/999', '111': 'https://x/111' })
  assertEquals(rows.map((r) => r.reactor_id), ['AAA', 'Z', 'Y'])
  assertEquals([rows[1].post_id, rows[1].post_url], ['999', 'https://x/999'])
  assertEquals(rows[2].post_id, '111', 'query URL maps back to the known post id')
})

Deno.test('aggregateReactors dedupes by LinkedIn URL with the posts reacted to, for one influencer', () => {
  const r = (id: string, post: string, headline = 'h') =>
    ({ post_id: post, post_url: '', reaction_type: 'LIKE', reactor_id: id, reactor_name: id.toLowerCase(), reactor_url: `https://www.linkedin.com/in/${id}`, reactor_headline: headline })
  const out = aggregateReactors([r('X', '1', ''), r('X', '2'), r('X', '2'), r('Y', '3', '')], 'peter-lohmann')
  assertEquals(out, [
    { linkedin_url: 'https://www.linkedin.com/in/X', linkedin_id: 'X', name: 'x', headline: 'h', slug: 'peter-lohmann', post_ids: ['1', '2'] },
    { linkedin_url: 'https://www.linkedin.com/in/Y', linkedin_id: 'Y', name: 'y', headline: '', slug: 'peter-lohmann', post_ids: ['3'] },
  ])
})

Deno.test('aggregateReactors builds a URL from the actor id when the URL is missing; drops non-LinkedIn URLs', () => {
  const out = aggregateReactors([
    { post_id: '1', post_url: '', reaction_type: '', reactor_id: 'ACoAAB', reactor_name: 'a', reactor_url: '', reactor_headline: '' },
    { post_id: '1', post_url: '', reaction_type: '', reactor_id: 'Q', reactor_name: 'q', reactor_url: 'https://evil.example/in/Q', reactor_headline: '' },
  ], 's')
  assertEquals(out.map((o) => o.linkedin_url), ['https://www.linkedin.com/in/ACoAAB'])
})

// ---------------------------------------------------------------------------
// triage (test_triage)

Deno.test('triage request: one id<TAB>headline line per reactor, headline cut at 300', () => {
  const req = triageRequest([{ id: 1, headline: 'Owner\tAcme' }, { id: 2, headline: 'y'.repeat(400) }])
  const user = req.messages[0].content
  assert(user.includes('1\tOwner Acme'))
  assert(!user.includes('y'.repeat(301)))
})

Deno.test('parseTriage: labels per id; unknown or missing id is "no"; bad label is "no"', () => {
  const labels = parseTriage({ results: [{ id: '1', label: 'likely' }, { id: '2', label: 'maybe' }] }, [1, 2, 3])
  assertEquals(labels, { 1: 'likely', 2: 'no', 3: 'no' })
})

Deno.test('triageTodo: empty headline is "no" without a call; the rest batch', () => {
  const t = triageTodo([{ id: 1, headline: '' }, { id: 2, headline: ' h ' }, { id: 3, headline: null }])
  assertEquals(t.noCall, [1, 3])
  assertEquals(t.ask.map((r) => r.id), [2])
})

// ---------------------------------------------------------------------------
// verify (test_verify)

Deno.test('perplexity request: sonar, low search context, 600 tokens', () => {
  const req = perplexityRequest('question?')
  assertEquals(req.model, 'sonar')
  assertEquals(req.web_search_options, { search_context_size: 'low' })
  assertEquals(req.max_tokens, 600)
  assertEquals(req.messages, [{ role: 'user', content: 'question?' }])
})

Deno.test('parsePerplexity reads answer, citations and cost; cost defaults to $0.006', () => {
  const out = parsePerplexity({
    choices: [{ message: { content: 'Alice owns Acme PM, 450 doors [1]' } }],
    citations: ['https://acmepm.com/about'],
    usage: { cost: { total_cost: 0.0042 } },
  })
  assertEquals(out, { answer: 'Alice owns Acme PM, 450 doors [1]', citations: ['https://acmepm.com/about'], cost: 0.0042 })
  assertEquals(parsePerplexity({ choices: [{ message: { content: 'ok' } }] }).cost, 0.006)
  assertThrows(() => parsePerplexity({ choices: [] }))
})

Deno.test('verification question mentions name, headline and doors; door question names the company', () => {
  const q = verificationQuestion('Alice Owner', 'Owner, Acme PM')
  assert(q.includes('Alice Owner') && q.includes('Acme PM') && q.toLowerCase().includes('doors'))
  assert(doorQuestion('Acme PM', 'Austin, TX').includes('"Acme PM" (Austin, TX)'))
})

Deno.test('retryable: 429 and 5xx retry; 400 does not', () => {
  assert(retryable(429) && retryable(503) && !retryable(400) && !retryable(401))
})

const base = {
  is_pm_company: true, is_decision_maker: true, company_name: 'Acme', company_website: '', location: '', city: '', state: '', country: '',
  title: 'Owner', door_count: 450 as number | null, door_count_source: 'https://acmepm.com/about', door_count_confidence: 'high' as const, reason: 'r',
}

Deno.test('verdict needs a PM company AND a decision maker', () => {
  assertEquals(verdict(base), 'verified')
  assertEquals(verdict({ ...base, is_decision_maker: false }), 'rejected')
  assertEquals(verdict({ ...base, is_pm_company: false }), 'rejected')
})

Deno.test('door count is kept only when its source is one of the citations', () => {
  assertEquals(groundDoorCount(base, ['https://acmepm.com/about']).door_count, 450)
  const out = groundDoorCount(base, ['https://elsewhere.com'])
  assertEquals([out.door_count, out.door_count_source, out.door_count_confidence], [null, '', ''])
  assertEquals(groundDoorCount({ ...base, door_count_source: '' }, ['']).door_count, null)
  assertEquals(groundDoorCount({ ...base, door_count_confidence: '' }, ['https://acmepm.com/about']).door_count, null, 'no confidence: dropped')
  assertEquals(groundDoorCount({ ...base, door_count: -5 }, ['https://acmepm.com/about']).door_count, null)
})

Deno.test('parseVerifyJson validates the Haiku JSON; a bad confidence or shape throws', () => {
  assertEquals(parseVerifyJson(base).company_name, 'Acme')
  assertEquals(parseVerifyJson({ ...base, door_count: 450.7 }).door_count, 450)
  assertThrows(() => parseVerifyJson({ ...base, door_count_confidence: 'certain' }))
  assertThrows(() => parseVerifyJson({ ...base, is_pm_company: 'yes' }))
  assertThrows(() => parseVerifyJson(null))
})

Deno.test('verify parse request carries the person, answer and numbered citations', () => {
  const req = verifyParseRequest('Alice', 'Owner', 'answer text', ['https://a', 'https://b'])
  const user = req.messages[0].content
  assert(user.includes('Person: Alice') && user.includes('[2] https://b') && user.includes('answer text'))
})

Deno.test('verifyTodo: never-verified and errors under 2 attempts; candidates only', () => {
  const rows = [
    { id: 1, triage: 'likely', verdict: null, verify_attempts: 0 },
    { id: 2, triage: 'possible', verdict: 'error', verify_attempts: 1 },
    { id: 3, triage: 'likely', verdict: 'error', verify_attempts: 2 },
    { id: 4, triage: 'likely', verdict: 'verified', verify_attempts: 1 },
    { id: 5, triage: 'no', verdict: null, verify_attempts: 0 },
  ]
  assertEquals(verifyTodo(rows).map((r) => r.id), [1, 2])
})

Deno.test('doorRetryTodo excludes retried, counted, nameless and rejected rows (test_pipeline)', () => {
  const b = { verdict: 'verified', company_name: 'Acme PM', door_count: null, door_retried: false }
  const rows = [
    { ...b, id: 1 },
    { ...b, id: 2, door_retried: true },
    { ...b, id: 3, door_count: 450 },
    { ...b, id: 4, company_name: '' },
    { ...b, id: 5, verdict: 'rejected' },
  ]
  assertEquals(doorRetryTodo(rows).map((r) => r.id), [1])
})

// ---------------------------------------------------------------------------
// haiku (test_llm)

Deno.test('haiku JSON request: model, system, schema in output_config, low effort', () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
  const req = buildJsonRequest('s', 'u', schema, 1000)
  assertEquals(req.model, 'claude-haiku-5-5')
  assertEquals(req.system, 's')
  assertEquals(req.output_config, { effort: 'low', format: { type: 'json_schema', schema } })
})

Deno.test('haiku JSON response: parses the text block; truncated or refused throws', () => {
  assertEquals(parseJsonResponse({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"ok":true}' }] }).json, { ok: true })
  assertThrows(() => parseJsonResponse({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"ok": tr' }] }), Error, 'max_tokens')
  assertThrows(() => parseJsonResponse({ stop_reason: 'refusal', content: [] }), Error, 'refusal')
})
