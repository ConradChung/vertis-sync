// Run: deno test --allow-env company-research/
import { assert, assertEquals } from 'jsr:@std/assert@1'
import { json, prepareModule, type Route, stubFetch } from '../_shared/test_fetch.ts'

prepareModule({
  SUPABASE_URL: 'https://db.test',
  SUPABASE_SERVICE_ROLE_KEY: 'svc',
  APIFY_API_TOKEN: 'apify-tok',
  ANTHROPIC_API_KEY: 'ant-key',
})
const { handle, continueCrawl, EXTRACT_CUTOFF_MS, WALL_CLOCK_MS } = await import('./index.ts')

const COMPANY = '11111111-1111-4111-8111-111111111111'
const CRAWL = '22222222-2222-4222-8222-222222222222'

const post = (body: unknown, auth = 'Bearer svc') =>
  new Request('https://fn.test/company-research', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
    body: JSON.stringify(body),
  })

const bodyOf = (calls: { url: string; method: string; body: string | null }[], match: (u: string, m: string) => boolean) =>
  calls.filter((c) => match(c.url, c.method)).map((c) => JSON.parse(c.body ?? 'null'))

function startRoutes(opts: { reserve?: unknown; usage?: Response } = {}): Route[] {
  return [
    [(u) => u === 'https://db.test/rest/v1/rpc/lume_research_fail_stale_crawls', () => json(0)],
    [(u, m) => u.startsWith('https://db.test/rest/v1/companies') && m === 'POST', () => json([{ id: COMPANY }], 201)],
    [(u) => u === 'https://api.apify.com/v2/users/me/usage/monthly', () => opts.usage ?? json({ data: { totalUsageCreditsUsdAfterVolumeDiscount: 3.5 } })],
    [(u) => u === 'https://db.test/rest/v1/rpc/lume_research_reserve_crawl', () =>
      json(opts.reserve ?? {
        ok: true, crawl_id: CRAWL, basis: 'account', account_usd: 3.5, reserved_usd: 0.04, month_spend_usd: 0.4,
        committed_usd: 3.54, estimate_usd: 0.02, cap_usd: 29,
      })],
    [(u, m) => u.startsWith('https://api.apify.com/v2/acts/apify~website-content-crawler/runs') && m === 'POST', () =>
      json({ data: { id: 'run1', status: 'READY', defaultDatasetId: 'ds1' } }, 201)],
    [(u, m) => u.startsWith('https://db.test/rest/v1/company_crawls?id=eq.') && m === 'PATCH', () => json([{ id: CRAWL }])],
    [(u) => u.startsWith('https://db.test/rest/v1/rpc/lume_alert_upsert'), () => json('a1')],
  ]
}

Deno.test('auth: no bearer, wrong bearer, anon-style bearer -> 401, nothing called', async () => {
  const f = stubFetch(startRoutes())
  try {
    for (const auth of ['', 'Bearer nope', 'svc', 'Bearer svc2']) {
      const res = await handle(post({ domain: 'acme-pm.com' }, auth), () => {})
      assertEquals(res.status, 401, auth)
    }
    assertEquals(f.calls.length, 0)
  } finally { f.restore() }
})

Deno.test('input: GET is 405; bad JSON, missing or bad domain is 400', async () => {
  const f = stubFetch(startRoutes())
  try {
    assertEquals((await handle(new Request('https://fn.test/', { method: 'GET' }), () => {})).status, 405)
    const bad = new Request('https://fn.test/', { method: 'POST', headers: { Authorization: 'Bearer svc' }, body: '{' })
    assertEquals((await handle(bad, () => {})).status, 400)
    for (const b of [{}, { domain: 'localhost' }, { url: 'ftp://x.com' }]) {
      const res = await handle(post(b), () => {})
      assertEquals(res.status, 400, JSON.stringify(b))
    }
    assertEquals(f.calls.length, 0)
  } finally { f.restore() }
})

Deno.test('budget gate: Apify usage + month spend + estimate is checked before any spend; budget_exceeded starts nothing', async () => {
  const f = stubFetch(startRoutes({
    reserve: { ok: false, error: 'budget_exceeded', basis: 'account', account_usd: 28.99, reserved_usd: 0, committed_usd: 28.99, estimate_usd: 0.02, cap_usd: 29 },
  }))
  try {
    const res = await handle(post({ url: 'https://www.acme-pm.com/about' }), () => {})
    assertEquals(res.status, 409)
    const body = await res.json()
    assertEquals(body.error, 'budget_exceeded')
    assertEquals([body.basis, body.committed_usd, body.cap_usd], ['account', 28.99, 29])
    const [rpc] = bodyOf(f.calls, (u) => u.endsWith('/rpc/lume_research_reserve_crawl'))
    assertEquals(rpc, { p_company: COMPANY, p_start_url: 'https://www.acme-pm.com/', p_estimate: 0.02, p_external_usd: 3.5, p_cap: 29 })
    assert(!f.calls.some((c) => c.url.includes('/acts/')), 'no Apify run started')
  } finally { f.restore() }
})

Deno.test('budget gate: the cap comes from LUME_RESEARCH_APIFY_CAP_USD; unreadable Apify usage is sent as null (ledger fallback), never 0', async () => {
  Deno.env.set('LUME_RESEARCH_APIFY_CAP_USD', '12')
  const f = stubFetch(startRoutes({ usage: new Response('nope', { status: 403 }), reserve: { ok: false, error: 'budget_exceeded' } }))
  try {
    await handle(post({ domain: 'acme-pm.com' }), () => {})
    const [rpc] = bodyOf(f.calls, (u) => u.endsWith('/rpc/lume_research_reserve_crawl'))
    assertEquals([rpc.p_external_usd, rpc.p_cap], [null, 12])
  } finally {
    Deno.env.delete('LUME_RESEARCH_APIFY_CAP_USD')
    f.restore()
  }
})

Deno.test('budget gate: Apify usage that is not a number is unreadable too (null)', async () => {
  const f = stubFetch(startRoutes({ usage: json({ data: { totalUsageCreditsUsdAfterVolumeDiscount: 'n/a' } }), reserve: { ok: false, error: 'budget_exceeded' } }))
  try {
    await handle(post({ domain: 'acme-pm.com' }), () => {})
    const [rpc] = bodyOf(f.calls, (u) => u.endsWith('/rpc/lume_research_reserve_crawl'))
    assertEquals(rpc.p_external_usd, null)
  } finally { f.restore() }
})

Deno.test('crawl_in_progress is a 409 too', async () => {
  const f = stubFetch(startRoutes({ reserve: { ok: false, error: 'crawl_in_progress' } }))
  try {
    const res = await handle(post({ domain: 'acme-pm.com' }), () => {})
    assertEquals([res.status, (await res.json()).error], [409, 'crawl_in_progress'])
  } finally { f.restore() }
})

Deno.test('start: upserts the company, starts a capped cheerio run, marks the crawl running, continues in the background', async () => {
  const f = stubFetch(startRoutes())
  const bg: Promise<unknown>[] = []
  try {
    const res = await handle(post({ domain: 'Acme-PM.com' }), (p) => { bg.push(p.catch(() => {})) }, { startedAt: 0, sleep: () => Promise.resolve() })
    assertEquals(res.status, 202)
    assertEquals(await res.json(), {
      ok: true, crawl_id: CRAWL, company_id: COMPANY, domain: 'acme-pm.com',
      estimate_usd: 0.02, basis: 'account', account_usd: 3.5, reserved_usd: 0.04, committed_usd: 3.54, cap_usd: 29,
    })
    const [company] = bodyOf(f.calls, (u, m) => u.startsWith('https://db.test/rest/v1/companies') && m === 'POST')
    assertEquals(company, { domain: 'acme-pm.com', website: 'https://acme-pm.com/' })
    const run = f.calls.find((c) => c.url.includes('/acts/apify~website-content-crawler/runs'))!
    const q = new URL(run.url).searchParams
    assertEquals([q.get('timeout'), q.get('memory')], ['180', '1024'])
    assert(!run.url.includes('apify-tok'), 'token goes in the header, not the URL')
    const input = JSON.parse(run.body!)
    assertEquals([input.crawlerType, input.maxCrawlPages, input.startUrls], ['cheerio', 8, [{ url: 'https://acme-pm.com/' }]])
    const [patch] = bodyOf(f.calls, (u, m) => u.startsWith('https://db.test/rest/v1/company_crawls?id=eq.') && m === 'PATCH')
    assertEquals([patch.status, patch.apify_run_id, patch.actor_id], ['running', 'run1', 'apify~website-content-crawler'])
    assertEquals(bg.length, 1)
  } finally {
    await Promise.all(bg)
    f.restore()
  }
})

Deno.test('start: Apify refuses the run -> crawl failed at $0, 502', async () => {
  const routes = startRoutes()
  routes.unshift([(u, m) => u.includes('/acts/') && m === 'POST', () => json({ error: { message: 'Not enough credit' } }, 402)])
  const f = stubFetch(routes)
  try {
    const res = await handle(post({ domain: 'acme-pm.com' }), () => {})
    assertEquals(res.status, 502)
    const [patch] = bodyOf(f.calls, (u, m) => u.startsWith('https://db.test/rest/v1/company_crawls?id=eq.') && m === 'PATCH')
    assertEquals([patch.status, patch.cost_usd], ['failed', 0])
  } finally { f.restore() }
})

// --- continuation -------------------------------------------------------------

const crawlRow = { id: CRAWL, company_id: COMPANY, status: 'running', apify_run_id: 'run1', estimate_usd: 0.02, start_url: 'https://acme-pm.com/', extraction: null }
const items = [
  {
    url: 'https://acme-pm.com/',
    text: 'Acme Property Management. We manage 1,237 doors across Greater Vancouver.',
    html: '<nav><a href="https://acme.appfolio.com/connect">Resident Login</a></nav>',
    markdown: '',
  },
  {
    url: 'https://acme-pm.com/contact',
    text: 'Office: 123 Main St, Burnaby, BC V5H 2E2. 24/7 emergency maintenance line.',
    html: '',
    markdown: '',
  },
]
const haiku = {
  content: [{
    type: 'tool_use',
    name: 'record_facts',
    input: {
      facts: [
        { field: 'door_count', value: 1237, confidence: 'high', snippet: 'We manage 1,237 doors', source_url: 'https://acme-pm.com/' },
        { field: 'city', value: 'Burnaby', confidence: 'high', snippet: '123 Main St, Burnaby, BC', source_url: 'https://acme-pm.com/contact' },
        { field: 'after_hours', value: true, confidence: 'high', snippet: '24/7 emergency maintenance line', source_url: 'https://acme-pm.com/contact' },
        { field: 'region', value: 'BC', confidence: 'high', snippet: 'Burnaby, British Columbia', source_url: 'https://acme-pm.com/contact' },
      ],
    },
  }],
  usage: { input_tokens: 900, output_tokens: 120 },
}

function continueRoutes(run: Record<string, unknown>, extra: Route[] = []): Route[] {
  return [
    ...extra,
    [(u) => u === 'https://db.test/rest/v1/rpc/lume_research_fail_stale_crawls', () => json(0)],
    [(u, m) => u.startsWith('https://db.test/rest/v1/company_crawls?id=eq.') && m === 'GET', () => json([crawlRow])],
    [(u) => u.startsWith('https://api.apify.com/v2/actor-runs/run1'), () => json({ data: run })],
    [(u) => u.startsWith('https://api.apify.com/v2/datasets/ds1/items'), () => json(items)],
    [(u) => u === 'https://api.anthropic.com/v1/messages', () => json(haiku)],
    [(u, m) => u.startsWith('https://db.test/rest/v1/company_crawls?id=eq.') && m === 'PATCH', () => json([{ id: CRAWL }])],
    [(u, m) => u === 'https://db.test/rest/v1/company_facts' && m === 'POST', () => new Response(null, { status: 201 })],
    [(u, m) => u.startsWith('https://db.test/rest/v1/companies?id=eq.') && m === 'PATCH', () => new Response(null, { status: 204 })],
    [(u) => u.startsWith('https://db.test/rest/v1/rpc/lume_alert_upsert'), () => json('a1')],
    [(u) => u === 'https://db.test/functions/v1/company-research', () => json({ ok: true })],
  ]
}

Deno.test('continue: a finished run -> pages snapshot, PMS + verified Haiku facts with source URLs, actual cost recorded', async () => {
  const f = stubFetch(continueRoutes({ id: 'run1', status: 'SUCCEEDED', defaultDatasetId: 'ds1', usageTotalUsd: 0.0041 }))
  try {
    await continueCrawl(CRAWL, { startedAt: Date.now(), sleep: () => Promise.resolve() })
    const ant = f.calls.find((c) => c.url === 'https://api.anthropic.com/v1/messages')!
    assertEquals(JSON.parse(ant.body!).model, 'claude-haiku-5-5')
    const [facts] = bodyOf(f.calls, (u, m) => u === 'https://db.test/rest/v1/company_facts' && m === 'POST')
    assertEquals(facts.map((r: Record<string, unknown>) => [r.field, r.value, r.copy_value, r.confidence, r.source_url]), [
      ['pms', 'appfolio', null, 'high', 'https://acme-pm.com/'],
      ['door_count', 1237, 1200, 'high', 'https://acme-pm.com/'],
      ['after_hours', true, null, 'high', 'https://acme-pm.com/contact'],
      ['city', 'Burnaby', null, 'high', 'https://acme-pm.com/contact'],
    ])
    for (const r of facts) {
      assertEquals([r.company_id, r.crawl_id], [COMPANY, CRAWL])
      assert(typeof r.snippet === 'string' && r.snippet.length > 0)
      assert(/^https?:\/\//.test(r.source_url))
    }
    const patches = bodyOf(f.calls, (u, m) => u.startsWith('https://db.test/rest/v1/company_crawls?id=eq.') && m === 'PATCH')
    const claim = f.calls.find((c) => c.method === 'PATCH' && c.url.includes('company_crawls'))!
    assert(claim.url.includes('status=eq.running') && claim.url.includes('extraction=is.null'), 'finishing is claimed once')
    const done = patches.at(-1)
    assertEquals([done.status, done.cost_usd, done.page_count], ['succeeded', 0.0041, 2])
    assertEquals(done.pages.map((p: { url: string }) => p.url), ['https://acme-pm.com/', 'https://acme-pm.com/contact'])
    assertEquals(done.extraction.pms.value, 'appfolio')
    assertEquals(done.extraction.dropped, [{ field: 'region', reason: 'snippet_not_on_page', source_url: 'https://acme-pm.com/contact' }])
    assert(f.calls.some((c) => c.url.startsWith('https://db.test/rest/v1/companies?id=eq.') && c.method === 'PATCH'))
  } finally { f.restore() }
})

Deno.test('continue: a failed run is recorded as failed with its actual cost; no extraction', async () => {
  const f = stubFetch(continueRoutes({ id: 'run1', status: 'FAILED', statusMessage: 'boom', defaultDatasetId: 'ds1', usageTotalUsd: 0.003 }))
  try {
    await continueCrawl(CRAWL, { startedAt: Date.now(), sleep: () => Promise.resolve() })
    assert(!f.calls.some((c) => c.url.includes('anthropic')))
    assert(!f.calls.some((c) => c.url.includes('company_facts')))
    const done = bodyOf(f.calls, (u, m) => u.startsWith('https://db.test/rest/v1/company_crawls?id=eq.') && m === 'PATCH').at(-1)
    assertEquals([done.status, done.cost_usd], ['failed', 0.003])
    assert(String(done.error).includes('FAILED'))
  } finally { f.restore() }
})

Deno.test('continue: past the wall-clock chunk the poll hands off to itself with the crawl id', async () => {
  const f = stubFetch(continueRoutes({ id: 'run1', status: 'RUNNING', defaultDatasetId: 'ds1' }))
  try {
    await continueCrawl(CRAWL, { startedAt: Date.now() - 200_000, sleep: () => Promise.resolve() })
    const hand = f.calls.find((c) => c.url === 'https://db.test/functions/v1/company-research')!
    assertEquals(JSON.parse(hand.body!), { crawl_id: CRAWL })
    assert(!f.calls.some((c) => c.method === 'PATCH'), 'no state change on hand-off')
  } finally { f.restore() }
})

Deno.test('continue: Haiku failure still records cost, pages and the PMS fact; the crawl is failed with the reason', async () => {
  const f = stubFetch(continueRoutes(
    { id: 'run1', status: 'SUCCEEDED', defaultDatasetId: 'ds1', usageTotalUsd: 0.004 },
    [[(u) => u === 'https://api.anthropic.com/v1/messages', () => json({ error: { message: 'overloaded' } }, 529)]],
  ))
  try {
    await continueCrawl(CRAWL, { startedAt: Date.now(), sleep: () => Promise.resolve() })
    const [facts] = bodyOf(f.calls, (u, m) => u === 'https://db.test/rest/v1/company_facts' && m === 'POST')
    assertEquals(facts.map((r: Record<string, unknown>) => r.field), ['pms'])
    const done = bodyOf(f.calls, (u, m) => u.startsWith('https://db.test/rest/v1/company_crawls?id=eq.') && m === 'PATCH').at(-1)
    assertEquals([done.status, done.cost_usd, done.page_count], ['failed', 0.004, 2])
    assert(String(done.error).startsWith('extraction_failed'))
  } finally { f.restore() }
})

Deno.test('continue: a crawl already finished (or claimed) is left alone', async () => {
  const f = stubFetch(continueRoutes({ id: 'run1', status: 'SUCCEEDED', defaultDatasetId: 'ds1' }, [
    [(u, m) => u.startsWith('https://db.test/rest/v1/company_crawls?id=eq.') && m === 'GET', () => json([{ ...crawlRow, status: 'succeeded' }])],
  ]))
  try {
    await continueCrawl(CRAWL, { startedAt: Date.now(), sleep: () => Promise.resolve() })
    assert(!f.calls.some((c) => c.url.includes('apify.com')))
  } finally { f.restore() }
})

Deno.test('handle {crawl_id}: authorized continuation is accepted and runs in the background', async () => {
  const f = stubFetch(continueRoutes({ id: 'run1', status: 'RUNNING', defaultDatasetId: 'ds1' }))
  const bg: Promise<unknown>[] = []
  try {
    const fast = { startedAt: Date.now() - 200_000, sleep: () => Promise.resolve() }
    const res = await handle(post({ crawl_id: CRAWL }), (p) => { bg.push(p.catch(() => {})) }, fast)
    assertEquals(res.status, 202)
    assertEquals(bg.length, 1)
    await Promise.all(bg)
    assert(f.calls.some((c) => c.url === 'https://db.test/functions/v1/company-research'), 'continued (and handed off)')
    assertEquals((await handle(post({ crawl_id: 'nope' }), () => {})).status, 400)
  } finally {
    f.restore()
  }
})

// --- stale sweep ----------------------------------------------------------------

const sweepCalls = <T extends { url: string; body: string | null }>(calls: T[]) => calls.filter((c) => c.url === 'https://db.test/rest/v1/rpc/lume_research_fail_stale_crawls')

Deno.test('sweep: every start first fails crawls stuck > 15 minutes, before the budget gate', async () => {
  const f = stubFetch(startRoutes({ reserve: { ok: false, error: 'budget_exceeded' } }))
  try {
    await handle(post({ domain: 'acme-pm.com' }), () => {})
    const sweeps = sweepCalls(f.calls)
    assertEquals(sweeps.length, 1)
    assertEquals(JSON.parse(sweeps[0].body!), { p_minutes: 15 })
    const iSweep = f.calls.findIndex((c) => c.url.endsWith('/rpc/lume_research_fail_stale_crawls'))
    const iGate = f.calls.findIndex((c) => c.url.endsWith('/rpc/lume_research_reserve_crawl'))
    assert(iSweep < iGate, 'sweep runs before the reservation, so a stuck crawl frees its company and its reservation')
  } finally { f.restore() }
})

Deno.test('sweep: a continuation invocation sweeps too', async () => {
  const f = stubFetch(continueRoutes({ id: 'run1', status: 'RUNNING', defaultDatasetId: 'ds1' }))
  const bg: Promise<unknown>[] = []
  try {
    await handle(post({ crawl_id: CRAWL }), (p) => { bg.push(p.catch(() => {})) }, { startedAt: Date.now() - 200_000, sleep: () => Promise.resolve() })
    await Promise.all(bg)
    assertEquals(sweepCalls(f.calls).length, 1)
  } finally { f.restore() }
})

Deno.test('sweep: a failing sweep is logged and never blocks the request', async () => {
  const routes = startRoutes()
  routes.unshift([(u) => u.endsWith('/rpc/lume_research_fail_stale_crawls'), () => new Response('boom', { status: 500 })])
  const f = stubFetch(routes)
  try {
    const res = await handle(post({ domain: 'acme-pm.com' }), () => {})
    assertEquals(res.status, 202)
  } finally { f.restore() }
})

Deno.test('sweep: unauthorized or invalid requests do not touch the database', async () => {
  const f = stubFetch(startRoutes())
  try {
    await handle(post({ domain: 'acme-pm.com' }, 'Bearer nope'), () => {})
    await handle(post({ domain: 'localhost' }), () => {})
    assertEquals(sweepCalls(f.calls).length, 0)
  } finally { f.restore() }
})

// --- wall clock (review item 1) -------------------------------------------------

const succeeded = { id: 'run1', status: 'SUCCEEDED', defaultDatasetId: 'ds1', usageTotalUsd: 0.004 }
const handedOff = (calls: { url: string }[]) => calls.some((c) => c.url === 'https://db.test/functions/v1/company-research')
const extracted = (calls: { url: string }[]) => calls.some((c) => c.url === 'https://api.anthropic.com/v1/messages')

Deno.test('wall clock: a finished run past the extraction cutoff hands off to a fresh invocation instead of extracting', async () => {
  const f = stubFetch(continueRoutes(succeeded))
  try {
    await continueCrawl(CRAWL, { startedAt: Date.now() - (EXTRACT_CUTOFF_MS + 5_000), sleep: () => Promise.resolve() })
    assert(handedOff(f.calls))
    assert(!extracted(f.calls))
    assert(!f.calls.some((c) => c.url.includes('/datasets/')), 'not even the dataset read')
  } finally { f.restore() }
})

Deno.test('wall clock: under the cutoff it extracts in this invocation', async () => {
  const f = stubFetch(continueRoutes(succeeded))
  try {
    await continueCrawl(CRAWL, { startedAt: Date.now() - (EXTRACT_CUTOFF_MS - 5_000), sleep: () => Promise.resolve() })
    assert(extracted(f.calls))
    assert(!handedOff(f.calls))
  } finally { f.restore() }
})

Deno.test('wall clock: the cutoff leaves room for the dataset read (20 s), Haiku (60 s), writes and a margin in a 150 s wall clock', () => {
  assertEquals(WALL_CLOCK_MS, 150_000)
  assert(EXTRACT_CUTOFF_MS + 20_000 + 60_000 + 10_000 + 10_000 <= WALL_CLOCK_MS)
})

Deno.test('wall clock: the clock starts at the request, so time spent in start() counts', async () => {
  let clock = 5_000_000
  const routes = [
    [(u: string) => u === 'https://db.test/rest/v1/rpc/lume_research_reserve_crawl', () => {
      clock += 60_000 // a slow start: Apify usage + gate + run start
      return json({ ok: true, crawl_id: CRAWL, basis: 'account', cap_usd: 29 })
    }] as Route,
    ...continueRoutes(succeeded),
    ...startRoutes(),
  ]
  const f = stubFetch(routes)
  const bg: Promise<unknown>[] = []
  try {
    const res = await handle(post({ domain: 'acme-pm.com' }), (p) => { bg.push(p) }, { now: () => clock, sleep: () => Promise.resolve() })
    assertEquals(res.status, 202)
    await Promise.all(bg)
    assert(handedOff(f.calls), 'extraction moved to a fresh invocation')
    assert(!extracted(f.calls))
  } finally { f.restore() }
})

Deno.test('hand-off: each attempt is time-boxed (AbortSignal), so a hung invoke cannot eat the wall clock', async () => {
  const f = stubFetch(continueRoutes({ id: 'run1', status: 'RUNNING', defaultDatasetId: 'ds1' }))
  const stubbed = globalThis.fetch
  const signals: (AbortSignal | null | undefined)[] = []
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === 'https://db.test/functions/v1/company-research') signals.push(init?.signal)
    return stubbed(input, init)
  }) as typeof fetch
  try {
    await continueCrawl(CRAWL, { startedAt: Date.now() - 200_000, sleep: () => Promise.resolve() })
    assertEquals(signals.length, 1)
    assert(signals[0] instanceof AbortSignal, 'the hand-off fetch carries a timeout signal')
  } finally {
    globalThis.fetch = stubbed
    f.restore()
  }
})

Deno.test('start: an Apify start that times out (outcome unknown) keeps the estimate as the cost, not $0', async () => {
  const routes = startRoutes()
  routes.unshift([(u, m) => u.includes('/acts/') && m === 'POST', () => { throw new DOMException('Signal timed out.', 'TimeoutError') }])
  const f = stubFetch(routes)
  try {
    const res = await handle(post({ domain: 'acme-pm.com' }), () => {})
    assertEquals(res.status, 502)
    const [patch] = bodyOf(f.calls, (u, m) => u.startsWith('https://db.test/rest/v1/company_crawls?id=eq.') && m === 'PATCH')
    assertEquals(patch.status, 'failed')
    assert(!('cost_usd' in patch), 'cost stays at the reserved estimate')
    assert(String(patch.error).includes('unknown'), 'the error says the outcome is unknown')
  } finally { f.restore() }
})
