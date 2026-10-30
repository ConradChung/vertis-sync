// Run: deno test --allow-env company-research/
import { assert, assertEquals } from 'jsr:@std/assert@1'
import { json, prepareModule, type Route, stubFetch } from '../_shared/test_fetch.ts'

prepareModule({
  SUPABASE_URL: 'https://db.test',
  SUPABASE_SERVICE_ROLE_KEY: 'svc',
  APIFY_API_TOKEN: 'apify-tok',
  ANTHROPIC_API_KEY: 'ant-key',
})
const { handle, continueCrawl } = await import('./index.ts')

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
    [(u, m) => u.startsWith('https://db.test/rest/v1/companies') && m === 'POST', () => json([{ id: COMPANY }], 201)],
    [(u) => u === 'https://api.apify.com/v2/users/me/usage/monthly', () => opts.usage ?? json({ data: { totalUsageCreditsUsdAfterVolumeDiscount: 3.5 } })],
    [(u) => u === 'https://db.test/rest/v1/rpc/lume_research_reserve_crawl', () =>
      json(opts.reserve ?? { ok: true, crawl_id: CRAWL, month_spend_usd: 0.4, external_usd: 3.5, estimate_usd: 0.02, cap_usd: 29 })],
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
    reserve: { ok: false, error: 'budget_exceeded', month_spend_usd: 1.2, external_usd: 28, estimate_usd: 0.02, cap_usd: 29 },
  }))
  try {
    const res = await handle(post({ url: 'https://www.acme-pm.com/about' }), () => {})
    assertEquals(res.status, 409)
    const body = await res.json()
    assertEquals(body.error, 'budget_exceeded')
    assertEquals(body.cap_usd, 29)
    const [rpc] = bodyOf(f.calls, (u) => u.endsWith('/rpc/lume_research_reserve_crawl'))
    assertEquals(rpc, { p_company: COMPANY, p_start_url: 'https://www.acme-pm.com/', p_estimate: 0.02, p_external_usd: 3.5, p_cap: 29 })
    assert(!f.calls.some((c) => c.url.includes('/acts/')), 'no Apify run started')
  } finally { f.restore() }
})

Deno.test('budget gate: the cap comes from LUME_RESEARCH_APIFY_CAP_USD; unreadable Apify usage counts as 0', async () => {
  Deno.env.set('LUME_RESEARCH_APIFY_CAP_USD', '12')
  const f = stubFetch(startRoutes({ usage: new Response('nope', { status: 403 }), reserve: { ok: false, error: 'budget_exceeded' } }))
  try {
    await handle(post({ domain: 'acme-pm.com' }), () => {})
    const [rpc] = bodyOf(f.calls, (u) => u.endsWith('/rpc/lume_research_reserve_crawl'))
    assertEquals([rpc.p_external_usd, rpc.p_cap], [0, 12])
  } finally {
    Deno.env.delete('LUME_RESEARCH_APIFY_CAP_USD')
    f.restore()
  }
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
      estimate_usd: 0.02, month_spend_usd: 0.4, external_usd: 3.5, cap_usd: 29,
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
  routes.splice(3, 1, [(u, m) => u.includes('/acts/') && m === 'POST', () => json({ error: { message: 'Not enough credit' } }, 402)])
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
