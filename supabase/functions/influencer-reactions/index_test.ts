// Run: deno test --allow-env influencer-reactions/
import { assert, assertEquals } from 'jsr:@std/assert@1'
import { json, prepareModule, type Route, stubFetch } from '../_shared/test_fetch.ts'

prepareModule({
  SUPABASE_URL: 'https://db.test',
  SUPABASE_SERVICE_ROLE_KEY: 'svc',
  APIFY_API_TOKEN: 'apify-tok',
  ANTHROPIC_API_KEY: 'ant-key',
  PERPLEXITY_API_KEY: 'pplx-key',
})
const { handle, advance } = await import('./index.ts')

const RUN = '11111111-1111-4111-8111-111111111111'
const INF = '22222222-2222-4222-8222-222222222222'
const ACTION = '33333333-3333-4333-8333-333333333333'
const PREV = '44444444-4444-4444-8444-444444444444'
const APROW = '55555555-5555-4555-8555-555555555555'

const post = (body: unknown, auth = 'Bearer svc') =>
  new Request('https://fn.test/influencer-reactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
    body: JSON.stringify(body),
  })

const db = (path: string) => (u: string, m?: string) => u.startsWith(`https://db.test/rest/v1/${path}`) && (m === undefined || true)
const is = (path: string, method: string) => (u: string, m: string) => u.startsWith(`https://db.test/rest/v1/${path}`) && m === method
const bodies = (calls: { url: string; method: string; body: string | null }[], match: (u: string, m: string) => boolean) =>
  calls.filter((c) => match(c.url, c.method)).map((c) => JSON.parse(c.body ?? 'null'))

const common: Route[] = [
  [(u) => u === 'https://db.test/rest/v1/rpc/lume_influencer_sweep', () => json([])],
  [db('rpc/lume_alert_upsert'), () => json('a1')],
]

const noWait = () => {}

const influencer = { id: INF, name: 'Peter Lohmann', slug: 'peter-lohmann', linkedin_url: 'https://www.linkedin.com/in/pslohmann', lookback_days: 90, max_reactions_per_post: 1000, last_posts: 317 }

function claimed(stage: string, extra: Record<string, unknown> = {}) {
  return {
    id: RUN, status: 'running', stage, influencer_ids: [INF], max_verify_usd: 10, reactions_estimate: null,
    reactions_estimate_usd: null, counts: {}, cost: {}, lease_token: 't', ...extra,
  }
}

const clock = () => {
  let t = 0
  return { now: () => t, sleep: (ms: number) => { t += ms; return Promise.resolve() }, tick: (ms: number) => { t += ms } }
}

// ---------------------------------------------------------------------------
// entry

Deno.test('auth: no bearer, wrong bearer -> 401 and nothing called', async () => {
  const f = stubFetch(common)
  try {
    for (const auth of ['', 'Bearer nope', 'svc']) assertEquals((await handle(post({ action: 'cancel', run_id: RUN }, auth), noWait)).status, 401)
    assertEquals(f.calls.length, 0)
  } finally { f.restore() }
})

Deno.test('input: GET 405, bad JSON 400, unknown action 400, bad continue 400', async () => {
  const f = stubFetch(common)
  try {
    assertEquals((await handle(new Request('https://fn.test/', { method: 'GET' }), noWait)).status, 405)
    const bad = new Request('https://fn.test/', { method: 'POST', headers: { Authorization: 'Bearer svc' }, body: '{' })
    assertEquals((await handle(bad, noWait)).status, 400)
    assertEquals((await handle(post({ action: 'explode' }), noWait)).status, 400)
    assertEquals((await handle(post({ run_id: RUN }), noWait)).status, 400)
  } finally { f.restore() }
})

Deno.test('start: validates influencer ids and the Perplexity cap', async () => {
  const f = stubFetch([...common, [is('influencers', 'GET'), () => json([])]])
  try {
    assertEquals((await handle(post({ action: 'start', influencer_ids: [] }), noWait)).status, 400)
    assertEquals((await handle(post({ action: 'start', influencer_ids: ['nope'] }), noWait)).status, 400)
    assertEquals((await handle(post({ action: 'start', influencer_ids: [INF], max_verify_usd: 51 }), noWait)).status, 400)
    const inactive = await handle(post({ action: 'start', influencer_ids: [INF] }), noWait)
    assertEquals([inactive.status, (await inactive.json()).error], [400, 'influencer_not_found_or_inactive'])
    assert(!f.calls.some((c) => c.method === 'POST' && c.url.includes('influencer_runs')), 'no run created')
  } finally { f.restore() }
})

Deno.test('start: creates the run, answers 202 and advances in the background', async () => {
  const waits: Promise<unknown>[] = []
  const f = stubFetch([
    ...common,
    [is('influencer_runs?start_action_id', 'GET'), () => json([])],
    [is('influencers', 'GET'), () => json([{ id: INF }])],
    [is('influencer_runs', 'POST'), () => json([{ id: RUN }], 201)],
    [db('rpc/lume_influencer_claim_run'), () => json([])],
  ])
  try {
    const res = await handle(post({ action: 'start', influencer_ids: [INF.toUpperCase()], max_verify_usd: 5, start_action_id: ACTION, estimate: { posts_usd: 0.6 } }), (p) => waits.push(p))
    assertEquals(res.status, 202)
    assertEquals((await res.json()).run_id, RUN)
    await Promise.all(waits)
    const [row] = bodies(f.calls, is('influencer_runs', 'POST'))
    assertEquals(row, { influencer_ids: [INF], max_verify_usd: 5, start_action_id: ACTION, status: 'running', stage: 'posts', estimate: { posts_usd: 0.6 } })
    assert(f.calls.some((c) => c.url.endsWith('rpc/lume_influencer_claim_run')), 'advance claimed the run')
    assert(f.calls.some((c) => c.url.endsWith('rpc/lume_influencer_sweep')), 'the sweep ran')
  } finally { f.restore() }
})

Deno.test('start: the same approval twice returns the existing run; a second active run is 409', async () => {
  const f = stubFetch([...common, [is('influencer_runs?start_action_id', 'GET'), () => json([{ id: RUN, status: 'running' }])]])
  try {
    const res = await handle(post({ action: 'start', influencer_ids: [INF], start_action_id: ACTION }), noWait)
    assertEquals([res.status, (await res.json()).existing], [200, true])
  } finally { f.restore() }
  const g = stubFetch([
    ...common,
    [is('influencers', 'GET'), () => json([{ id: INF }])],
    [is('influencer_runs', 'POST'), () => json({ code: '23505' }, 409)],
  ])
  try {
    const res = await handle(post({ action: 'start', influencer_ids: [INF] }), noWait)
    assertEquals([res.status, (await res.json()).error], [409, 'run_in_progress'])
  } finally { g.restore() }
})

Deno.test('approve_reactions: only while awaiting and only when the approved amount covers the bill', async () => {
  const f = stubFetch([
    ...common,
    [is('influencer_runs', 'PATCH'), () => json([])],
    [is('influencer_runs', 'GET'), () => json([{ id: RUN, status: 'awaiting_approval', stage: 'reactions', reactions_estimate_usd: 3.2 }])],
  ])
  try {
    const res = await handle(post({ action: 'approve_reactions', run_id: RUN, approved_usd: 3.1, reactions_action_id: ACTION }), noWait)
    assertEquals(res.status, 409)
    assertEquals((await res.json()).error, 'not_awaiting_or_bill_changed')
    const patch = f.calls.find((c) => c.method === 'PATCH')!
    assert(patch.url.includes('status=eq.awaiting_approval') && patch.url.includes('reactions_estimate_usd=lte.3.1'), patch.url)
  } finally { f.restore() }
  const waits: Promise<unknown>[] = []
  const g = stubFetch([...common, [is('influencer_runs', 'PATCH'), () => json([{ id: RUN }])], [db('rpc/lume_influencer_claim_run'), () => json([])]])
  try {
    const res = await handle(post({ action: 'approve_reactions', run_id: RUN, approved_usd: 3.2, max_verify_usd: 4 }), (p) => waits.push(p))
    assertEquals(res.status, 202)
    await Promise.all(waits)
    const [patch] = bodies(g.calls, is('influencer_runs', 'PATCH'))
    assertEquals([patch.status, patch.reactions_approved_usd, patch.max_verify_usd], ['running', 3.2, 4])
  } finally { g.restore() }
})

Deno.test('cancel: cancels the run and aborts its live Apify runs', async () => {
  const f = stubFetch([
    ...common,
    [db('rpc/lume_influencer_cancel_run'), () => json({ ok: true, abort: ['runAAAAAAAA1'] })],
    [(u, m) => u === 'https://api.apify.com/v2/actor-runs/runAAAAAAAA1/abort' && m === 'POST', () => json({ data: {} })],
  ])
  try {
    const res = await handle(post({ action: 'cancel', run_id: RUN }), noWait)
    assertEquals([res.status, (await res.json()).aborted], [200, 1])
    assert(f.calls.some((c) => c.url.endsWith('/actor-runs/runAAAAAAAA1/abort')))
  } finally { f.restore() }
})

// ---------------------------------------------------------------------------
// stages

Deno.test('advance: a run held by another invocation is left alone', async () => {
  const f = stubFetch([[db('rpc/lume_influencer_claim_run'), () => json([])]])
  try {
    await advance(RUN, PREV, { handOff: () => { throw new Error('no hand-off') } })
    assertEquals(f.calls.length, 1)
    assertEquals(JSON.parse(f.calls[0].body!).p_prev, PREV)
  } finally { f.restore() }
})

Deno.test('posts: reserves on the shared budget, starts with maxTotalChargeUsd, records the run id; waits while it runs', async () => {
  const c = clock()
  let rowsCall = 0
  const f = stubFetch([
    [db('rpc/lume_influencer_claim_run'), () => json([claimed('posts')])],
    [is('influencers', 'GET'), () => json([influencer])],
    [is('influencer_apify_runs', 'GET'), () => json(rowsCall++ === 0 ? [] : [{ id: APROW, influencer_id: INF, kind: 'posts', status: 'running', apify_run_id: 'runAAAAAAAA1', estimate_usd: 1.06, cost_usd: 1.06 }])],
    [(u) => u === 'https://api.apify.com/v2/users/me/usage/monthly', () => json({ data: { totalUsageCreditsUsdAfterVolumeDiscount: 4 } })],
    [db('rpc/lume_influencer_reserve_apify'), () => json({ ok: true, existing: false, id: APROW })],
    [(u, m) => u.startsWith('https://api.apify.com/v2/acts/harvestapi~linkedin-profile-posts/runs') && m === 'POST', () => json({ data: { id: 'runAAAAAAAA1', defaultDatasetId: 'dsAAAAAAAA1' } }, 201)],
    [is('influencer_apify_runs', 'PATCH'), () => json([{ id: APROW }])],
    [(u) => u === 'https://api.apify.com/v2/actor-runs/runAAAAAAAA1', () => json({ data: { status: 'RUNNING' } })],
  ])
  try {
    let handed = false
    await advance(RUN, null, { now: c.now, sleep: c.sleep, startedAt: 0, handOff: () => { handed = true; return Promise.resolve(true) } })
    const reserve = bodies(f.calls, (u) => u.endsWith('rpc/lume_influencer_reserve_apify'))[0]
    assertEquals([reserve.p_kind, reserve.p_estimate, reserve.p_external_usd, reserve.p_cap], ['posts', 1.06, 4, 29])
    const start = f.calls.find((c) => c.url.includes('/acts/harvestapi~linkedin-profile-posts/runs'))!
    assert(start.url.includes('maxTotalChargeUsd=1.06') && start.url.includes('maxItems=530'), start.url)
    assertEquals(JSON.parse(start.body!).targetUrls, ['https://www.linkedin.com/in/pslohmann'])
    assertEquals(bodies(f.calls, is('influencer_apify_runs', 'PATCH'))[0].apify_run_id, 'runAAAAAAAA1')
    assert(f.calls.find((x) => x.method === 'PATCH' && x.url.includes('influencer_apify_runs'))!.url.includes('status=eq.pending'))
    assert(handed, 'still running at the cutoff: handed off')
  } finally { f.restore() }
})

Deno.test('posts: over the monthly cap -> recorded as a failed $0 row, no Apify start', async () => {
  const c = clock()
  let rowsCall = 0
  const f = stubFetch([
    [db('rpc/lume_influencer_claim_run'), () => json([claimed('posts')])],
    [is('influencers', 'GET'), () => json([influencer])],
    [is('influencer_apify_runs', 'GET'), () => json(rowsCall++ === 0 ? [] : [{ id: APROW, influencer_id: INF, kind: 'posts', status: 'failed', cost_usd: 0, item_count: null }])],
    [(u) => u === 'https://api.apify.com/v2/users/me/usage/monthly', () => json({}, 500)],
    [db('rpc/lume_influencer_reserve_apify'), () => json({ ok: false, error: 'budget_exceeded', committed_usd: 28.5, cap_usd: 29 })],
    [is('influencer_apify_runs', 'POST'), () => json([], 201)],
    [is('influencer_runs', 'PATCH'), () => json([{ id: RUN }])],
    [is('influencer_posts', 'GET'), () => json([])],
  ])
  try {
    await advance(RUN, null, { now: c.now, sleep: c.sleep, startedAt: 0, handOff: () => Promise.resolve(true) })
    assert(!f.calls.some((x) => x.url.includes('/acts/')), 'no Apify start')
    const [failed] = bodies(f.calls, is('influencer_apify_runs', 'POST'))
    assertEquals([failed.status, failed.cost_usd], ['failed', 0])
    assert(String(failed.error).startsWith('budget_exceeded'))
    assertEquals(bodies(f.calls, (u) => u.endsWith('rpc/lume_influencer_reserve_apify'))[0].p_external_usd, null, 'unreadable usage -> ledger basis')
  } finally { f.restore() }
})

Deno.test('top_posts: ranks the top 10 and stops at awaiting_approval with the exact reactions bill', async () => {
  const posts = Array.from({ length: 12 }, (_, i) => ({
    run_id: RUN, influencer_id: INF, post_id: String(i), post_url: `https://x/${i}`, posted_at: null, likes: 100 * (i + 1),
    comments: 0, shares: 0, text: 't', pm_relevant: true, relevance_reason: 'r', rank: null,
  })).reverse()
  const f = stubFetch([
    ...common,
    [db('rpc/lume_influencer_claim_run'), () => json([claimed('top_posts')])],
    [(u) => u.startsWith('https://db.test/rest/v1/influencer_posts?') && u.includes('pm_relevant=is.null'), () => json([])],
    [is('influencers', 'GET'), () => json([{ ...influencer, max_reactions_per_post: 1000 }])],
    [(u) => u.includes('influencer_posts?') && u.includes('pm_relevant=is.true'), () => json(posts.slice(0, 10))],
    [is('influencer_posts', 'POST'), () => json([], 201)],
    [is('influencer_runs', 'PATCH'), () => json([{ id: RUN }])],
  ])
  try {
    await advance(RUN, null, { handOff: () => { throw new Error('must not hand off') } })
    const ranked = bodies(f.calls, is('influencer_posts', 'POST'))[0]
    assertEquals(ranked.map((p: { rank: number }) => p.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    const patch = bodies(f.calls, is('influencer_runs', 'PATCH')).at(-1)
    // likes 1200..300, all under the 1000 cap except 1200, 1100 -> 1000 + 1000 + 1000 + 900 + ... + 300 = 7200
    assertEquals([patch.status, patch.stage, patch.reactions_estimate_usd, patch.lease_token], ['awaiting_approval', 'reactions', 10.8, null])
    assertEquals(patch.reactions_estimate[0], { influencer_id: INF, slug: 'peter-lohmann', name: 'Peter Lohmann', posts: 10, reactions: 7200, usd: 10.8 })
    assert(f.calls.some((c) => c.url.endsWith('rpc/lume_alert_upsert')), 'the owner is pinged')
  } finally { f.restore() }
})

Deno.test('reactions: an existing reservation is never started again; a finished dataset is merged once and costed', async () => {
  const c = clock()
  const f = stubFetch([
    [db('rpc/lume_influencer_claim_run'), () => json([claimed('reactions', {
      reactions_estimate: [{ influencer_id: INF, slug: 'peter-lohmann', name: 'Peter Lohmann', posts: 2, reactions: 3, usd: 0.01 }],
    })])],
    [is('influencers', 'GET'), () => json([influencer])],
    [is('influencer_apify_runs?run_id', 'GET'), () => json([{ id: APROW, influencer_id: INF, kind: 'reactions', status: 'running', apify_run_id: 'runBBBBBBBB2', dataset_id: 'dsBBBBBBBB2', estimate_usd: 0.07, cost_usd: 0.07 }])],
    [(u) => u === 'https://api.apify.com/v2/actor-runs/runBBBBBBBB2', () => json({ data: { status: 'SUCCEEDED', defaultDatasetId: 'dsBBBBBBBB2', usageTotalUsd: 0.001 } })],
    [(u) => u.startsWith('https://api.apify.com/v2/datasets/dsBBBBBBBB2/items'), () => json([
      { reactionType: 'LIKE', postId: 'urn:li:activity:1', actor: { id: 'AAA', name: 'Alice', linkedinUrl: 'https://www.linkedin.com/in/AAA', position: 'Owner' }, query: { post: 'https://x/1' } },
      { reactionType: 'LIKE', postId: 'urn:li:activity:2', actor: { id: 'AAA', name: 'Alice', linkedinUrl: 'https://www.linkedin.com/in/AAA', position: 'Owner' }, query: { post: 'https://x/2' } },
    ])],
    [(u) => u.includes('influencer_posts?') && u.includes('select=post_id,post_url'), () => json([{ post_id: '1', post_url: 'https://x/1' }, { post_id: '2', post_url: 'https://x/2' }])],
    [db('rpc/lume_influencer_merge_reactions'), () => json({ ok: true, merged: 1, new_reactors: 1 })],
    [is('influencer_apify_runs', 'PATCH'), () => json([])],
    [is('influencer_runs', 'PATCH'), () => json([{ id: RUN }])],
    [is('influencer_reactors', 'GET'), () => json([])],
  ])
  try {
    await advance(RUN, null, { now: c.now, sleep: c.sleep, startedAt: 0, handOff: () => Promise.resolve(true) })
    assert(!f.calls.some((x) => x.url.includes('rpc/lume_influencer_reserve_apify')), 'no second reservation for an existing row')
    assert(!f.calls.some((x) => x.url.includes('/acts/')), 'no second start')
    const [merge] = bodies(f.calls, (u) => u.endsWith('rpc/lume_influencer_merge_reactions'))
    assertEquals(merge, { p_apify_row: APROW, p_rows: [{ linkedin_url: 'https://www.linkedin.com/in/AAA', linkedin_id: 'AAA', name: 'Alice', headline: 'Owner', slug: 'peter-lohmann', post_ids: ['1', '2'] }] })
    const done = bodies(f.calls, is('influencer_apify_runs', 'PATCH'))[0]
    assertEquals([done.status, done.item_count, done.cost_usd], ['succeeded', 2, 0.003])
  } finally { f.restore() }
})

Deno.test('verify: stops at the Perplexity cap and goes to output', async () => {
  const c = clock()
  const f = stubFetch([
    ...common,
    [db('rpc/lume_influencer_claim_run'), () => json([claimed('verify', { max_verify_usd: 1, cost: { perplexity: 0.995 } })])],
    [is('influencer_runs', 'PATCH'), () => json([{ id: RUN }])],
    [is('influencers', 'GET'), () => json([influencer])],
    [is('influencer_reactors', 'GET'), () => json([])],
    [is('influencer_apify_runs', 'GET'), () => json([])],
    [is('influencers', 'PATCH'), () => json([])],
  ])
  try {
    await advance(RUN, null, { now: c.now, sleep: c.sleep, startedAt: 0, handOff: () => Promise.resolve(true) })
    assert(!f.calls.some((x) => x.url.includes('perplexity')), 'no Perplexity call over the cap')
    const patches = bodies(f.calls, is('influencer_runs', 'PATCH'))
    assertEquals([patches[0].stage, patches[0].counts.verify_capped], ['output', true])
    assertEquals(patches.at(-1).status, 'done')
  } finally { f.restore() }
})

Deno.test('verify: Perplexity + Haiku parse, door count kept only from a cited source', async () => {
  const c = clock()
  let reactorsGet = 0
  const f = stubFetch([
    [db('rpc/lume_influencer_claim_run'), () => json([claimed('verify')])],
    [is('influencer_reactors', 'GET'), () => json(reactorsGet++ === 0 ? [{ id: 7, name: 'Alice', headline: 'Owner, Acme PM', triage: 'likely', verdict: null, verify_attempts: 0, company_name: null, location: null, door_count: null, door_retried: false, pplx_cost_usd: 0 }] : [])],
    [(u) => u === 'https://api.perplexity.ai/chat/completions', () => json({ choices: [{ message: { content: 'Alice owns Acme PM, 450 doors [1]' } }], citations: ['https://acmepm.com/about'], usage: { cost: { total_cost: 0.005 } } })],
    [(u) => u === 'https://api.anthropic.com/v1/messages', () => json({
      stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 100 },
      content: [{ type: 'text', text: JSON.stringify({ is_pm_company: true, is_decision_maker: true, title: 'Owner', company_name: 'Acme PM', company_website: 'https://acmepm.com', location: 'Austin, Texas', city: 'Austin', state: 'Texas', country: 'United States', door_count: 450, door_count_source: 'https://elsewhere.com', door_count_confidence: 'high', reason: 'r' }) }],
    })],
    [is('influencer_reactors', 'PATCH'), () => json([])],
    [is('influencer_runs', 'PATCH'), () => json([{ id: RUN }])],
    // the run then moves through doors (nothing to retry) to output
    ...common,
    [is('influencers', 'GET'), () => json([influencer])],
    [is('influencer_apify_runs', 'GET'), () => json([])],
    [is('influencers', 'PATCH'), () => json([])],
  ])
  try {
    await advance(RUN, null, { now: c.now, sleep: c.sleep, startedAt: 0, handOff: () => Promise.resolve(true) })
    const [row] = bodies(f.calls, is('influencer_reactors', 'PATCH'))
    assertEquals([row.verdict, row.company_name, row.city, row.door_count, row.door_count_source, row.pplx_cost_usd, row.verify_attempts],
      ['verified', 'Acme PM', 'Austin', null, null, 0.005, 1])
    const pplx = bodies(f.calls, (u) => u === 'https://api.perplexity.ai/chat/completions')[0]
    assertEquals(pplx.model, 'sonar')
    const cost = bodies(f.calls, is('influencer_runs', 'PATCH'))[0].cost
    assertEquals(cost.perplexity, 0.005)
    assertEquals(cost.anthropic, 0.00015)
  } finally { f.restore() }
})

// ---------------------------------------------------------------------------
// review fixes: money safety and resumability

const abortRoute = (ids: string[]): Route => [(u, m) => m === 'POST' && ids.some((id) => u === `https://api.apify.com/v2/actor-runs/${id}/abort`), () => json({ data: {} })]

Deno.test('C1: a fatal error mid-reactions fails the run AND its live Apify rows, and aborts them on Apify', async () => {
  const c = clock()
  const f = stubFetch([
    ...common,
    [db('rpc/lume_influencer_claim_run'), () => json([claimed('reactions', {
      reactions_estimate: [{ influencer_id: INF, slug: 'peter-lohmann', name: 'Peter Lohmann', posts: 2, reactions: 3, usd: 0.01 }],
    })])],
    [is('influencers', 'GET'), () => json([influencer])],
    [is('influencer_apify_runs?run_id', 'GET'), () => json([
      { id: APROW, influencer_id: INF, kind: 'reactions', status: 'running', apify_run_id: 'runBBBBBBBB2', dataset_id: 'dsBBBBBBBB2', estimate_usd: 0.07, cost_usd: 0.07 },
    ])],
    [(u) => u === 'https://api.apify.com/v2/actor-runs/runBBBBBBBB2', () => json({ data: { status: 'SUCCEEDED', defaultDatasetId: 'dsBBBBBBBB2' } })],
    [(u) => u.startsWith('https://api.apify.com/v2/datasets/dsBBBBBBBB2/items'), () => json([])],
    [(u) => u.includes('influencer_posts?'), () => json([])],
    [db('rpc/lume_influencer_merge_reactions'), () => json({ ok: false, error: 'not_found' })],
    [db('rpc/lume_influencer_fail_run'), () => json({ ok: true, abort: ['runCCCCCCCC3'] })],
    abortRoute(['runCCCCCCCC3']),
  ])
  try {
    await advance(RUN, null, { now: c.now, sleep: c.sleep, startedAt: 0, handOff: () => { throw new Error('no hand-off after a fatal error') } })
    const [failed] = bodies(f.calls, (u) => u.endsWith('rpc/lume_influencer_fail_run'))
    assertEquals(failed.p_run, RUN)
    assert(String(failed.p_error).startsWith('reactions: merge failed'), failed.p_error)
    assert(f.calls.some((x) => x.url.endsWith('/actor-runs/runCCCCCCCC3/abort')), 'live Apify run aborted')
    assert(!f.calls.some((x) => x.method === 'PATCH' && x.url.includes('influencer_runs')), 'no run-only PATCH that would leak the rows')
  } finally { f.restore() }
})

Deno.test('I3: a transient Haiku outage (529) leaves the run running and hands off; nothing is failed', async () => {
  const c = clock()
  let haikuCalls = 0
  const f = stubFetch([
    ...common,
    [db('rpc/lume_influencer_claim_run'), () => json([claimed('triage', { counts: { transient_streak: 1 } })])],
    [is('influencer_reactors', 'GET'), () => json([{ id: 1, headline: 'Owner, Acme PM' }])],
    [(u) => u === 'https://api.anthropic.com/v1/messages', () => { haikuCalls++; return json({ type: 'error' }, 529) }],
    [is('influencer_runs', 'PATCH'), () => json([{ id: RUN }])],
  ])
  try {
    let handed = false
    await advance(RUN, null, { now: c.now, sleep: c.sleep, startedAt: 0, handOff: () => { handed = true; return Promise.resolve(true) } })
    assertEquals(haikuCalls, 3, 'bounded retries')
    assert(handed, 'the next invocation retries')
    assert(!f.calls.some((x) => x.url.endsWith('rpc/lume_influencer_fail_run')), 'not failed')
    const patch = bodies(f.calls, is('influencer_runs', 'PATCH')).at(-1)
    assertEquals(patch.counts.transient_streak, 2)
    assert(String(patch.counts.last_transient_error).includes('529'))
  } finally { f.restore() }
})

Deno.test('I3: too many transient errors in a row fail the run through fail_run', async () => {
  const c = clock()
  const f = stubFetch([
    ...common,
    [db('rpc/lume_influencer_claim_run'), () => json([claimed('triage', { counts: { transient_streak: 7 } })])],
    [is('influencer_reactors', 'GET'), () => json([{ id: 1, headline: 'Owner' }])],
    [(u) => u === 'https://api.anthropic.com/v1/messages', () => json({}, 503)],
    [db('rpc/lume_influencer_fail_run'), () => json({ ok: true, abort: [] })],
  ])
  try {
    await advance(RUN, null, { now: c.now, sleep: c.sleep, startedAt: 0, handOff: () => { throw new Error('no hand-off') } })
    assert(f.calls.some((x) => x.url.endsWith('rpc/lume_influencer_fail_run')))
  } finally { f.restore() }
})

Deno.test('I3: an Apify run read that fails once (503) is retried', async () => {
  const c = clock()
  let reads = 0
  const f = stubFetch([
    [db('rpc/lume_influencer_claim_run'), () => json([claimed('posts')])],
    [is('influencers', 'GET'), () => json([influencer])],
    [is('influencer_apify_runs', 'GET'), () => json([{ id: APROW, influencer_id: INF, kind: 'posts', status: 'running', apify_run_id: 'runAAAAAAAA1', estimate_usd: 1, cost_usd: 1 }])],
    [(u) => u === 'https://api.apify.com/v2/actor-runs/runAAAAAAAA1', () => (reads++ === 0 ? json({}, 503) : json({ data: { status: 'RUNNING' } }))],
  ])
  try {
    await advance(RUN, null, { now: c.now, sleep: c.sleep, startedAt: 0, handOff: () => Promise.resolve(true) })
    assert(reads >= 2)
    assert(!f.calls.some((x) => x.url.includes('lume_influencer_fail_run')))
  } finally { f.restore() }
})

Deno.test('I1: a run cancelled mid-step reserves nothing more and starts no Apify run', async () => {
  const c = clock()
  const other = { ...influencer, id: '66666666-6666-4666-8666-666666666666', slug: 'deb-newell', name: 'Deb Newell' }
  const f = stubFetch([
    [db('rpc/lume_influencer_claim_run'), () => json([claimed('posts', { influencer_ids: [INF, other.id] })])],
    [is('influencers', 'GET'), () => json([influencer, other])],
    [is('influencer_apify_runs', 'GET'), () => json([])],
    [(u) => u === 'https://api.apify.com/v2/users/me/usage/monthly', () => json({ data: { totalUsageCreditsUsdAfterVolumeDiscount: 1 } })],
    [db('rpc/lume_influencer_reserve_apify'), () => json({ ok: false, error: 'run_not_running', status: 'cancelled' })],
  ])
  try {
    await advance(RUN, null, { now: c.now, sleep: c.sleep, startedAt: 0, handOff: () => { throw new Error('no hand-off') } })
    assertEquals(bodies(f.calls, (u) => u.endsWith('rpc/lume_influencer_reserve_apify')).length, 1, 'the second influencer is never reserved')
    assert(!f.calls.some((x) => x.url.includes('/acts/')), 'no Apify start')
    assert(!f.calls.some((x) => x.method === 'POST' && x.url.includes('influencer_apify_runs')), 'not recorded as a budget skip')
  } finally { f.restore() }
})

Deno.test('I2: a started run whose id cannot be recorded is aborted on Apify; the reservation stays as its cost', async () => {
  const c = clock()
  let rowsCall = 0
  const f = stubFetch([
    [db('rpc/lume_influencer_claim_run'), () => json([claimed('posts')])],
    [is('influencers', 'GET'), () => json([influencer])],
    [is('influencer_apify_runs', 'GET'), () => json(rowsCall++ === 0 ? [] : [{ id: APROW, influencer_id: INF, kind: 'posts', status: 'pending', apify_run_id: null, estimate_usd: 1.06, cost_usd: 1.06 }])],
    [(u) => u === 'https://api.apify.com/v2/users/me/usage/monthly', () => json({ data: { totalUsageCreditsUsdAfterVolumeDiscount: 1 } })],
    [db('rpc/lume_influencer_reserve_apify'), () => json({ ok: true, existing: false, id: APROW })],
    [(u, m) => u.includes('/acts/harvestapi~linkedin-profile-posts/runs') && m === 'POST', () => json({ data: { id: 'runHHHHHHHH8', defaultDatasetId: 'dsHHHHHHHH8' } }, 201)],
    [is('influencer_apify_runs', 'PATCH'), () => json({ message: 'db down' }, 503)],
    abortRoute(['runHHHHHHHH8']),
  ])
  try {
    await advance(RUN, null, { now: c.now, sleep: c.sleep, startedAt: 0, handOff: () => Promise.resolve(true) })
    assert(f.calls.some((x) => x.url.endsWith('/actor-runs/runHHHHHHHH8/abort')), 'aborted')
    const patches = bodies(f.calls, is('influencer_apify_runs', 'PATCH'))
    assert(patches.length >= 3, 'the PATCH was retried')
    const last = patches.at(-1)
    assertEquals(last.status, 'failed')
    assert(!('cost_usd' in last), 'the reservation stays as the cost')
    assert(String(last.error).includes('runHHHHHHHH8'), 'the run id is recorded in the error')
  } finally { f.restore() }
})

Deno.test('I2: a thrown start (outcome unknown) keeps the reservation; an Apify refusal is $0', async () => {
  for (const [res, refused] of [[() => { throw new TypeError('network') }, false], [() => json({ error: { message: 'no' } }, 402), true]] as const) {
    const c = clock()
    let rowsCall = 0
    const f = stubFetch([
      [db('rpc/lume_influencer_claim_run'), () => json([claimed('posts')])],
      [is('influencers', 'GET'), () => json([influencer])],
      [is('influencer_apify_runs', 'GET'), () => json(rowsCall++ === 0 ? [] : [{ id: APROW, influencer_id: INF, kind: 'posts', status: 'failed', cost_usd: 0, item_count: null }])],
      [(u) => u === 'https://api.apify.com/v2/users/me/usage/monthly', () => json({})],
      [db('rpc/lume_influencer_reserve_apify'), () => json({ ok: true, existing: false, id: APROW })],
      [(u, m) => u.includes('/acts/') && m === 'POST', res as () => Response],
      [is('influencer_apify_runs', 'PATCH'), () => json([])],
      [is('influencer_runs', 'PATCH'), () => json([{ id: RUN }])],
      [is('influencer_posts', 'GET'), () => json([])],
    ])
    try {
      await advance(RUN, null, { now: c.now, sleep: c.sleep, startedAt: 0, handOff: () => Promise.resolve(true) })
      const [p] = bodies(f.calls, is('influencer_apify_runs', 'PATCH'))
      assertEquals(p.status, 'failed')
      assertEquals('cost_usd' in p, refused, refused ? 'refusal is $0' : 'unknown keeps the reservation')
    } finally { f.restore() }
  }
})

Deno.test('sweep: every invocation runs lume_influencer_sweep and aborts the Apify runs it closed', async () => {
  const waits: Promise<unknown>[] = []
  const f = stubFetch([
    [(u) => u === 'https://db.test/rest/v1/rpc/lume_influencer_sweep', () => json([{ run_id: RUN, apify_run_id: 'runIIIIIIII9', reason: 'timed out' }, { run_id: RUN, apify_run_id: null, reason: 'never started' }])],
    abortRoute(['runIIIIIIII9']),
    [db('rpc/lume_influencer_cancel_run'), () => json({ ok: true, abort: [] })],
  ])
  try {
    await handle(post({ action: 'cancel', run_id: RUN }), (p) => waits.push(p))
    await Promise.all(waits)
    assert(f.calls.some((x) => x.url.endsWith('/actor-runs/runIIIIIIII9/abort')))
  } finally { f.restore() }
})

// ---------------------------------------------------------------------------
// review round 2

Deno.test('N1: a start that returns after a cancel never revives the row: the run is aborted at once and recorded', async () => {
  const c = clock()
  let rowsCall = 0
  const f = stubFetch([
    [db('rpc/lume_influencer_claim_run'), () => json([claimed('posts')])],
    [is('influencers', 'GET'), () => json([influencer])],
    [is('influencer_apify_runs', 'GET'), () => json(rowsCall++ === 0 ? [] : [{ id: APROW, influencer_id: INF, kind: 'posts', status: 'aborted', apify_run_id: null, estimate_usd: 1.06, cost_usd: 1.06 }])],
    [(u) => u === 'https://api.apify.com/v2/users/me/usage/monthly', () => json({ data: { totalUsageCreditsUsdAfterVolumeDiscount: 1 } })],
    [db('rpc/lume_influencer_reserve_apify'), () => json({ ok: true, existing: false, id: APROW })],
    [(u, m) => u.includes('/acts/harvestapi~linkedin-profile-posts/runs') && m === 'POST', () => json({ data: { id: 'runJJJJJJJJ1', defaultDatasetId: 'dsJJJJJJJJ1' } }, 201)],
    // status=eq.pending matches nothing: the cancel already aborted the row
    [(u, m) => m === 'PATCH' && u.includes('influencer_apify_runs') && u.includes('status=eq.pending'), () => json([])],
    [(u, m) => m === 'PATCH' && u.includes('influencer_apify_runs'), () => json([])],
    abortRoute(['runJJJJJJJJ1']),
    [is('influencer_runs', 'PATCH'), () => json([{ id: RUN }])],
    [is('influencer_posts', 'GET'), () => json([])],
  ])
  try {
    await advance(RUN, null, { now: c.now, sleep: c.sleep, startedAt: 0, handOff: () => Promise.resolve(true) })
    const patches = f.calls.filter((x) => x.method === 'PATCH' && x.url.includes('influencer_apify_runs'))
    assert(patches[0].url.includes('status=eq.pending'), 'the success PATCH is conditional on pending')
    assert(!patches.slice(1).some((p) => JSON.parse(p.body!).status === 'running'), 'never written running')
    assert(f.calls.some((x) => x.url.endsWith('/actor-runs/runJJJJJJJJ1/abort')), 'aborted at once')
    const rec = JSON.parse(patches[1].body!)
    assertEquals(rec.apify_run_id, 'runJJJJJJJJ1')
    assert(String(rec.error).includes('after the row was closed'))
  } finally { f.restore() }
})

Deno.test('N2: action sweep runs the sweep, aborts what it closed and answers with counts', async () => {
  const f = stubFetch([
    [(u) => u === 'https://db.test/rest/v1/rpc/lume_influencer_sweep', () => json([{ run_id: RUN, apify_run_id: 'runKKKKKKKK2', reason: 'stale' }, { run_id: RUN, apify_run_id: null, reason: 'never started' }])],
    abortRoute(['runKKKKKKKK2']),
  ])
  try {
    const res = await handle(post({ action: 'sweep' }), noWait)
    assertEquals(res.status, 200)
    assertEquals(await res.json(), { ok: true, closed: 2, aborted: 1 })
    assertEquals(f.calls.filter((x) => x.url.endsWith('rpc/lume_influencer_sweep')).length, 1, 'one sweep, not two')
  } finally { f.restore() }
})

Deno.test('minor: a transient Haiku error inside verify does not burn an attempt; its Perplexity cost is kept', async () => {
  const c = clock()
  const f = stubFetch([
    ...common,
    [db('rpc/lume_influencer_claim_run'), () => json([claimed('verify')])],
    [is('influencer_reactors', 'GET'), () => json([{ id: 7, name: 'Alice', headline: 'Owner', triage: 'likely', verdict: null, verify_attempts: 0, company_name: null, location: null, door_count: null, door_retried: false, pplx_cost_usd: 0 }])],
    [(u) => u === 'https://api.perplexity.ai/chat/completions', () => json({ choices: [{ message: { content: 'x' } }], citations: [], usage: { cost: { total_cost: 0.005 } } })],
    [(u) => u === 'https://api.anthropic.com/v1/messages', () => json({}, 529)],
    [is('influencer_reactors', 'PATCH'), () => json([])],
    [is('influencer_runs', 'PATCH'), () => json([{ id: RUN }])],
  ])
  try {
    let handed = false
    await advance(RUN, null, { now: c.now, sleep: c.sleep, startedAt: 0, handOff: () => { handed = true; return Promise.resolve(true) } })
    const [row] = bodies(f.calls, is('influencer_reactors', 'PATCH'))
    assertEquals(row, { pplx_cost_usd: 0.005, updated_at: row.updated_at }, 'only the cost; no verdict, no attempt')
    assert(handed, 'the next invocation retries')
    const runPatch = bodies(f.calls, is('influencer_runs', 'PATCH'))
    assertEquals(runPatch[0].cost.perplexity, 0.005)
    assertEquals(runPatch.at(-1).counts.transient_streak, 1)
  } finally { f.restore() }
})

Deno.test('minor: a running row near the sweep limit is aborted first, then what its dataset holds is ingested', async () => {
  const c = clock()
  let reads = 0
  const old = new Date(Date.now() - 26 * 60_000).toISOString()
  const f = stubFetch([
    [db('rpc/lume_influencer_claim_run'), () => json([claimed('posts')])],
    [is('influencers', 'GET'), () => json([influencer])],
    [is('influencer_apify_runs', 'GET'), () => json([{ id: APROW, influencer_id: INF, kind: 'posts', status: 'running', apify_run_id: 'runLLLLLLLL3', dataset_id: 'dsLLLLLLLL3', estimate_usd: 1, cost_usd: 1, started_at: old }])],
    [(u) => u === 'https://api.apify.com/v2/actor-runs/runLLLLLLLL3', () => json({ data: reads++ === 0 ? { status: 'RUNNING' } : { status: 'ABORTED', defaultDatasetId: 'dsLLLLLLLL3', usageTotalUsd: 0.2 } })],
    abortRoute(['runLLLLLLLL3']),
    [(u) => u.startsWith('https://api.apify.com/v2/datasets/dsLLLLLLLL3/items'), () => json([{ type: 'post', id: '1', linkedinUrl: 'https://x/1', engagement: { likes: 5 } }])],
    [is('influencer_posts', 'POST'), () => json([], 201)],
    [is('influencer_apify_runs', 'PATCH'), () => json([])],
  ])
  try {
    await advance(RUN, null, { now: c.now, sleep: c.sleep, startedAt: 0, handOff: () => Promise.resolve(true) })
    assert(f.calls.some((x) => x.url.endsWith('/actor-runs/runLLLLLLLL3/abort')), 'aborted')
    assertEquals(bodies(f.calls, is('influencer_posts', 'POST'))[0].length, 1, 'partial results ingested')
    const done = bodies(f.calls, is('influencer_apify_runs', 'PATCH'))[0]
    assertEquals([done.status, done.item_count], ['succeeded', 1])
    assert(String(done.error).includes('partial'))
  } finally { f.restore() }
})
