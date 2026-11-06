// Run: deno test --allow-env influencer-lookup/
import { assertEquals } from 'jsr:@std/assert@1'
import { json, prepareModule, type Route, stubFetch } from '../_shared/test_fetch.ts'

prepareModule({ SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'svc', ANTHROPIC_API_KEY: 'ant-key', PERPLEXITY_API_KEY: 'pplx-key' })
const { handle, runBatch } = await import('./index.ts')

const BATCH = '11111111-1111-4111-8111-111111111111'
const ACTION = '22222222-2222-4222-8222-222222222222'
const C1 = '33333333-3333-4333-8333-333333333333'
const C2 = '44444444-4444-4444-8444-444444444444'
const EXISTING = '55555555-5555-4555-8555-555555555555'

const post = (body: unknown, auth = 'Bearer svc') =>
  new Request('https://fn.test/influencer-lookup', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) }, body: JSON.stringify(body) })
const is = (path: string, method: string) => (u: string, m: string) => u.startsWith(`https://db.test/rest/v1/${path}`) && m === method
const bodies = (calls: { url: string; method: string; body: string | null }[], match: (u: string, m: string) => boolean) =>
  calls.filter((c) => match(c.url, c.method)).map((c) => ({ url: c.url, body: JSON.parse(c.body ?? 'null') }))
const clock = () => {
  let t = 0
  return { now: () => t, sleep: (ms: number) => { t += ms; return Promise.resolve() }, tick: (ms: number) => { t += ms } }
}
const noWait = () => {}

const pplx = (url: string, title: string) => json({
  choices: [{ message: { content: `Profile: ${url}` } }],
  citations: [url],
  search_results: [{ url, title, snippet: '' }],
  usage: { cost: { total_cost: 0.006 } },
})
const haiku = (url: string) => json({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ linkedin_url: url, evidence_url: url, evidence_quote: '', reason: 'r' }) }], usage: { input_tokens: 1000, output_tokens: 100 } })

Deno.test('auth: no bearer or a wrong one -> 401, nothing called', async () => {
  const f = stubFetch([])
  try {
    for (const a of ['', 'Bearer nope']) assertEquals((await handle(post({ action: 'sweep' }, a), noWait)).status, 401)
    assertEquals(f.calls.length, 0)
  } finally { f.restore() }
})

Deno.test('start: flips a staged batch to looking_up with the approved cap (on top of what was spent) and starts the chain', async () => {
  const kicked: Promise<unknown>[] = []
  const f = stubFetch([
    [is('influencer_candidate_batches?id=eq.', 'GET'), () => json([{ id: BATCH, status: 'staged', spent_usd: 0.5, lookup_action_id: null }])],
    [is('influencer_candidate_batches?id=eq.', 'PATCH'), (_u, b) => json([{ id: BATCH, ...JSON.parse(b!) }])],
  ])
  try {
    const res = await handle(post({ action: 'start', batch_id: BATCH, max_usd: 1.2, action_id: ACTION }), (p) => kicked.push(p), { run: () => Promise.resolve() })
    assertEquals(res.status, 202)
    const patch = bodies(f.calls, is('influencer_candidate_batches?id=eq.', 'PATCH'))[0]
    assertEquals(patch.url.includes('status=eq.staged'), true)
    assertEquals(patch.body, { status: 'looking_up', max_lookup_usd: 1.7, lookup_action_id: ACTION, lease_token: null, lease_until: null, error: null, updated_at: patch.body.updated_at })
    assertEquals(kicked.length, 1)
  } finally { f.restore() }
})

Deno.test('start: a batch already running for this action is a no-op 202; one in another state is 409', async () => {
  let row: Record<string, unknown> = { id: BATCH, status: 'looking_up', spent_usd: 0, lookup_action_id: ACTION }
  const f = stubFetch([[is('influencer_candidate_batches?id=eq.', 'GET'), () => json([row])]])
  try {
    assertEquals((await handle(post({ action: 'start', batch_id: BATCH, max_usd: 1, action_id: ACTION }), noWait, { run: () => Promise.resolve() })).status, 202)
    row = { id: BATCH, status: 'done', spent_usd: 0, lookup_action_id: null }
    assertEquals((await handle(post({ action: 'start', batch_id: BATCH, max_usd: 1, action_id: ACTION }), noWait, { run: () => Promise.resolve() })).status, 409)
    assertEquals(f.calls.filter((c) => c.method === 'PATCH').length, 0)
  } finally { f.restore() }
})

function chainRoutes(opts: { cap: number; spent?: number; candidates: Record<string, unknown>[][]; influencers?: unknown[] }) {
  let page = 0
  const routes: Route[] = [
    [is('influencer_candidate_batches?id=eq.', 'PATCH'), (u, b) => json(u.includes('lease_until') || u.includes('lease_token') ? [{ id: BATCH, status: 'looking_up', spent_usd: opts.spent ?? 0, max_lookup_usd: opts.cap, ...JSON.parse(b!) }] : [])],
    [is('influencer_candidates?batch_id=eq.', 'GET'), () => json(opts.candidates[page++] ?? [])],
    [is('influencer_candidates?id=eq.', 'PATCH'), () => new Response(null, { status: 204 })],
    [is('influencers?select=', 'GET'), () => json(opts.influencers ?? [])],
    [is('rpc/lume_alert_upsert', 'POST'), () => json('a1')],
  ]
  return routes
}

Deno.test('runBatch: looks up pending people (2 at a time), keeps only cited URLs, marks duplicates of existing influencers, finishes done', async () => {
  const f = stubFetch([
    ...chainRoutes({
      cap: 1,
      candidates: [[{ id: C1, name: 'Sarah Johnson', title: 'Director', company: 'Greystar', lookup_attempts: 0 }, { id: C2, name: 'Peter Lohmann', title: 'Founder', company: 'RL Property Management', lookup_attempts: 0 }], []],
      influencers: [{ id: EXISTING, linkedin_url: 'https://www.linkedin.com/in/pslohmann/' }],
    }),
    [(u, m) => u === 'https://api.perplexity.ai/chat/completions' && m === 'POST', (_u, b) => JSON.parse(b!).messages[0].content.includes('Sarah')
      ? pplx('https://www.linkedin.com/in/sarah-johnson', 'Sarah Johnson - Director - Greystar')
      : pplx('https://linkedin.com/in/PSLohmann', 'Peter Lohmann - Founder - RL Property Management')],
    [(u) => u === 'https://api.anthropic.com/v1/messages', (_u, b) => JSON.parse(b!).messages[0].content.includes('Sarah') ? haiku('https://www.linkedin.com/in/sarah-johnson') : haiku('https://linkedin.com/in/PSLohmann')],
  ])
  try {
    const c = clock()
    await runBatch(BATCH, null, { now: c.now, sleep: c.sleep, handOff: () => Promise.resolve(true) })
    const updates = bodies(f.calls, is('influencer_candidates?id=eq.', 'PATCH'))
    const sarah = updates.find((x) => x.url.includes(C1))!.body
    assertEquals([sarah.status, sarah.confidence, sarah.linkedin_url, sarah.lookup_attempts], ['found', 'high', 'https://www.linkedin.com/in/sarah-johnson', 1])
    const peter = updates.find((x) => x.url.includes(C2))!.body
    assertEquals([peter.status, peter.influencer_id, peter.linkedin_url], ['duplicate', EXISTING, 'https://www.linkedin.com/in/pslohmann'])
    // Only pending rows are updated.
    assertEquals(updates.every((x) => x.url.includes('status=eq.pending_lookup')), true)
    const batchPatches = bodies(f.calls, is('influencer_candidate_batches?id=eq.', 'PATCH')).map((x) => x.body)
    assertEquals(batchPatches.some((b) => b.spent_usd !== undefined && b.spent_usd > 0.012 && b.spent_usd < 0.013), true)
    assertEquals(batchPatches.at(-1)!.status, 'done')
  } finally { f.restore() }
})

Deno.test('runBatch: stops at the hard cap (status capped) without calling Perplexity past it', async () => {
  const f = stubFetch([
    ...chainRoutes({ cap: 0.005, candidates: [[{ id: C1, name: 'Sarah Johnson', title: 'Director', company: 'Greystar', lookup_attempts: 0 }]] }),
  ])
  try {
    const c = clock()
    await runBatch(BATCH, null, { now: c.now, sleep: c.sleep, handOff: () => Promise.resolve(true) })
    assertEquals(f.calls.some((x) => x.url.includes('perplexity')), false)
    assertEquals(bodies(f.calls, is('influencer_candidate_batches?id=eq.', 'PATCH')).at(-1)!.body.status, 'capped')
  } finally { f.restore() }
})

Deno.test('runBatch: a lease held by another invocation -> nothing happens', async () => {
  const f = stubFetch([[is('influencer_candidate_batches?id=eq.', 'PATCH'), () => json([])]])
  try {
    await runBatch(BATCH, null, { handOff: () => Promise.resolve(true) })
    assertEquals(f.calls.length, 1)
  } finally { f.restore() }
})

Deno.test('runBatch: a failed lookup counts an attempt; the second failure gives up as not_found with the error', async () => {
  const f = stubFetch([
    ...chainRoutes({ cap: 1, candidates: [[{ id: C1, name: 'Sarah Johnson', title: 'Director', company: 'Greystar', lookup_attempts: 1 }], []] }),
    [(u) => u === 'https://api.perplexity.ai/chat/completions', () => json({ error: 'bad' }, 400)],
  ])
  try {
    const c = clock()
    await runBatch(BATCH, null, { now: c.now, sleep: c.sleep, handOff: () => Promise.resolve(true) })
    const b = bodies(f.calls, is('influencer_candidates?id=eq.', 'PATCH'))[0].body
    assertEquals([b.status, b.confidence, b.lookup_attempts, String(b.lookup_error).startsWith('Perplexity 400')], ['not_found', 'not_found', 2, true])
  } finally { f.restore() }
})

Deno.test('sweep: re-kicks looking_up batches whose lease expired', async () => {
  const kicked: Promise<unknown>[] = []
  const f = stubFetch([[is('influencer_candidate_batches?status=eq.looking_up', 'GET'), () => json([{ id: BATCH }])]])
  try {
    const res = await handle(post({ action: 'sweep' }), (p) => kicked.push(p), { run: () => Promise.resolve() })
    assertEquals(res.status, 200)
    assertEquals(await res.json(), { ok: true, kicked: 1 })
    assertEquals(kicked.length, 1)
  } finally { f.restore() }
})
