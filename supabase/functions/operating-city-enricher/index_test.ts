// Run: deno test --allow-env operating-city-enricher/
import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1'
import { json, prepareModule, type Route, stubFetch } from '../_shared/test_fetch.ts'

prepareModule({ SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'svc', ANTHROPIC_API_KEY: 'ant-key', PERPLEXITY_API_KEY: 'pplx-key' })
const { processJob, timing } = await import('./index.ts')
// Real pacing / backoff are 1 s and 5-20 s; the tests keep the behaviour, not the wait.
timing.paceMs = 5
timing.backoffWaits = [5, 10, 20]

const JOB = '11111111-1111-4111-8111-111111111111'
const is = (path: string, method: string) => (u: string, m: string) => u.startsWith(`https://db.test/rest/v1/${path}`) && m === method
const has = (frag: string, method: string) => (u: string, m: string) => u.includes(frag) && m === method
const bodies = (calls: { url: string; method: string; body: string | null }[], match: (u: string, m: string) => boolean) =>
  calls.filter((c) => match(c.url, c.method)).map((c) => ({ url: c.url, body: JSON.parse(c.body ?? 'null') }))
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `row-${i}`, row_index: i, row_data: { company: `Co ${i}`, website: `co${i}.com`, email: `a${i}@co${i}.com` } }))

function routes(opts: { rows: ReturnType<typeof rowsOf>; pplx: (body: string) => Promise<Response> | Response; status?: () => string }): Route[] {
  let served = false
  return [
    [has('status=eq.pending&select=id&limit=1', 'GET'), () => json([])],
    [has('status=in.(pending,processing)', 'PATCH'), () => json([{ id: JOB }])],
    [has('select=id,filename,total_rows', 'GET'), () => json([{ id: JOB, filename: 'f.csv', total_rows: 20, enriched_rows: 0, column_order: ['company', 'website', 'email'], icp_description: null, icp_filter: false }])],
    [has('status=eq.valid&select=id', 'GET'), () => new Response('[]', { status: 200, headers: { 'content-range': `0-0/${opts.rows.length}`, 'content-type': 'application/json' } })],
    [has('select=status', 'GET'), () => json([{ status: opts.status?.() ?? 'processing' }])],
    [has('enrichment_status=eq.pending', 'GET'), () => { const r = served ? [] : opts.rows; served = true; return json(r) }],
    [has('select=enrichment_status', 'GET'), () => json(opts.rows.map(() => ({ enrichment_status: 'done' })))],
    [has('enrichment->>icp_status=eq.confirmed', 'GET'), () => json(opts.rows.map((r) => ({ id: r.id })))],
    [(u) => u.startsWith('https://api.perplexity.ai'), (_u, b) => opts.pplx(b!) as Response],
    [(u) => u.startsWith('https://api.anthropic.com'), (_u, b) => {
      const city = JSON.parse(b!).messages[0].content.match(/Company: Co (\d+)/)[1]
      return json({ content: [{ text: JSON.stringify({ operating_city: `City${city}`, secondary_cities: ['X'], confidence: 'high', icp_status: 'confirmed' }) }] })
    }],
    [is('validation_rows?id=eq.', 'PATCH'), () => new Response(null, { status: 204 })],
    [is('validation_jobs?id=eq.', 'PATCH'), () => new Response(null, { status: 204 })],
    [(u) => u.startsWith('https://db.test/rest/v1/'), () => new Response(null, { status: 201 })],
    [(u) => u.includes('/functions/v1/'), () => json({ ok: true })],
  ]
}

const research = (b: string) => `Research for ${JSON.parse(b).messages[0].content.match(/Company name: (Co \d+)/)[1]}`

Deno.test('enricher: 2 rows in flight at most, every row written exactly as before, counters settled, enriching ETA, chain back to email-validator', async () => {
  let inFlight = 0
  let maxInFlight = 0
  const rows = rowsOf(12)
  const f = stubFetch(routes({
    rows,
    pplx: async (b) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
      await delay(20)
      inFlight--
      return json({ choices: [{ message: { content: research(b) } }] })
    },
  }))
  try {
    await processJob(JOB)
    await delay(5)
    assertEquals(maxInFlight, 2)
    const rowPatches = bodies(f.calls, is('validation_rows?id=eq.', 'PATCH'))
    assertEquals(rowPatches.length, 12)
    assertEquals(new Set(rowPatches.map((p) => p.url)).size, 12)
    const r3 = rowPatches.find((p) => p.url.endsWith('id=eq.row-3'))!.body
    assertEquals(r3, {
      enrichment_status: 'done',
      enrichment: { operating_city: 'City3', secondary_cities: ['X'], confidence: 'high', icp_status: 'confirmed', research: 'Research for Co 3' },
      row_data: { company: 'Co 3', website: 'co3.com', email: 'a3@co3.com', operating_city: 'City3', secondary_cities: 'X', city_confidence: 'high', city_research: 'Research for Co 3', icp_status: 'confirmed' },
    })
    const jobPatches = bodies(f.calls, is('validation_jobs?id=eq.', 'PATCH')).map((p) => p.body)
    const settle = jobPatches.find((b) => b.eta_stage === 'enriching')
    assert(settle, 'an enriching ETA is written')
    assertEquals(settle.enriched_rows, 12)
    assertEquals(settle.eta_validate_seconds, 0)
    assertEquals(settle.eta_enrich_seconds, 0)
    assertEquals(typeof settle.eta_updated_at, 'string')
    assertEquals(f.calls.filter((c) => c.url.endsWith('/functions/v1/email-validator')).length, 1)
    assertEquals(f.calls.filter((c) => c.url.endsWith('/functions/v1/operating-city-enricher')).length, 0)
  } finally { f.restore() }
})

Deno.test('enricher: a Perplexity 429 is retried with backoff and the row still resolves', async () => {
  let calls = 0
  const f = stubFetch(routes({
    rows: rowsOf(1),
    pplx: (b) => (++calls === 1 ? new Response('rate limited', { status: 429 }) : json({ choices: [{ message: { content: research(b) } }] })),
  }))
  try {
    await processJob(JOB)
    assertEquals(calls, 2)
    assertEquals(bodies(f.calls, is('validation_rows?id=eq.', 'PATCH'))[0].body.enrichment_status, 'done')
  } finally { f.restore() }
})

Deno.test('enricher: a persistent 429 still marks the row error (same as before), the job carries on', async () => {
  const f = stubFetch(routes({ rows: rowsOf(1), pplx: () => new Response('rate limited', { status: 429 }) }))
  try {
    await processJob(JOB)
    const p = bodies(f.calls, is('validation_rows?id=eq.', 'PATCH'))[0].body
    assertEquals([p.enrichment_status, p.enrichment.operating_city], ['error', 'ERROR'])
    assert(p.enrichment.research.includes('429'))
  } finally { f.restore() }
})

Deno.test('enricher: a throw (a row write failing) stops the sibling, waits for the in-flight row, and propagates', async () => {
  let started = 0
  const base = routes({ rows: rowsOf(6), pplx: async (b) => { started++; await delay(10); return json({ choices: [{ message: { content: research(b) } }] }) } })
  const f = stubFetch([[is('validation_rows?id=eq.row-0', 'PATCH'), () => new Response('boom', { status: 500 })], ...base])
  try {
    await assertRejects(() => processJob(JOB), Error, 'boom')
    assert(started <= 3, `no new rows after the failure (started ${started})`)
    assertEquals(f.calls.filter((c) => c.url.includes('/functions/v1/')).length, 0)
  } finally { f.restore() }
})

Deno.test('enricher: near the chunk limit it stops taking rows, settles, and hands off once', async () => {
  const realNow = Date.now
  let t = realNow()
  Date.now = () => t
  const f = stubFetch(routes({
    rows: rowsOf(8),
    pplx: (b) => { t += 40_000; return json({ choices: [{ message: { content: research(b) } }] }) },
  }))
  try {
    await processJob(JOB)
    const rowPatches = bodies(f.calls, is('validation_rows?id=eq.', 'PATCH'))
    assert(rowPatches.length < 8 && rowPatches.length >= 2, `stopped early (${rowPatches.length})`)
    const last = bodies(f.calls, is('validation_jobs?id=eq.', 'PATCH')).map((p) => p.body).filter((b) => 'enriched_rows' in b).at(-1)!
    assertEquals(last.enriched_rows, rowPatches.length)
    assertEquals(f.calls.filter((c) => c.url.endsWith('/functions/v1/operating-city-enricher')).length, 1)
    assertEquals(f.calls.filter((c) => c.url.endsWith('/functions/v1/email-validator')).length, 0)
  } finally { Date.now = realNow; f.restore() }
})
