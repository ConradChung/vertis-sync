import { assert, assertEquals } from 'jsr:@std/assert@1'
import { BlitzSession, DECISION_MAKER_CASCADE, personLinkedinUrl } from './blitz.ts'

const KEY_INFO = { valid: true, records_remaining: 969, next_reset_at: '2026-12-15T11:01:03.241Z', max_requests_per_seconds: 5, allowed_apis: ['/enrichment/email'], active_plans: [] }
const fu = (used: number, remaining: number) => ({ records_used: used, records_remaining: remaining, request_id: 'r' })
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })

/** Fake clock + fetch: sleeps advance the clock instantly; every call is recorded with its start time. */
function harness(respond: (path: string, body: Record<string, unknown> | null, n: number) => Response | Promise<Response>, opts: { key?: string; maxRecords?: number; realTime?: boolean } = {}) {
  let t = 0
  const calls: { path: string; at: number; body: Record<string, unknown> | null; key: string | null }[] = []
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    calls.push({ path, at: opts.realTime ? performance.now() : t, body, key: new Headers(init?.headers).get('x-api-key') })
    return await respond(path, body, calls.length)
  }) as typeof fetch
  const s = new BlitzSession({
    apiKey: opts.key ?? 'test-key', fetch: f, maxRecords: opts.maxRecords,
    ...(opts.realTime ? {} : { now: () => t, sleep: async (ms: number) => { t += ms } }),
  })
  return { s, calls, clock: () => t }
}

const URL_A = 'https://www.linkedin.com/in/dana-whitfield'

Deno.test('found: key-info once, then 1 record per found email, countdown kept', async () => {
  const { s, calls } = harness((p) => p.endsWith('key-info') ? json(KEY_INFO) : json({ found: true, email: 'Dana@WhitfieldPM.com', fair_usage: fu(1, 968) }))
  assertEquals(await s.findWorkEmail(URL_A), { kind: 'found', email: 'dana@whitfieldpm.com' })
  assertEquals(await s.findWorkEmail('linkedin.com/in/sam-ortiz/'), { kind: 'found', email: 'dana@whitfieldpm.com' })
  assertEquals(calls.map((c) => c.path), ['/v2/account/key-info', '/v2/enrichment/email', '/v2/enrichment/email'])
  assertEquals(calls[1].body, { person_linkedin_url: URL_A })
  assertEquals(calls[2].body, { person_linkedin_url: 'https://www.linkedin.com/in/sam-ortiz' })
  assertEquals(calls[1].key, 'test-key')
  assertEquals(s.recordsUsed, 2)
  assertEquals(s.recordsRemaining, 968)
})

Deno.test('miss: found:false costs nothing and is a miss; 404 is a miss too', async () => {
  const { s } = harness((p, _b, n) => p.endsWith('key-info') ? json(KEY_INFO) : n === 2 ? json({ found: false, email: null, fair_usage: fu(0, 969) }) : json({ success: false, message: 'Not Found', fair_usage: { records_used: 0, request_id: 'r' } }, 404))
  assertEquals(await s.findWorkEmail(URL_A), { kind: 'miss' })
  assertEquals(await s.findWorkEmail(URL_A), { kind: 'miss' })
  assertEquals(s.recordsUsed, 0)
  assertEquals(s.unavailableReason, null)
})

Deno.test('429 then success: same row asked again after a short wait, all callers held', async () => {
  const { s, calls } = harness((p, _b, n) => {
    if (p.endsWith('key-info')) return json(KEY_INFO)
    if (n === 2) return json({ success: false, message: 'Rate limit exceeded', fair_usage: { records_used: 0, request_id: 'r' } }, 429)
    return json({ found: true, email: 'a@b.co', fair_usage: fu(1, 968) })
  })
  assertEquals(await s.findWorkEmail(URL_A), { kind: 'found', email: 'a@b.co' })
  assertEquals(calls.length, 3)
  assertEquals(calls[1].body, calls[2].body)
  assert(calls[2].at - calls[1].at >= 1000, 'waited at least the 1 s Retry-After')
})

Deno.test('429 forever: bounded retries, then unavailable rate_limited (session keeps going)', async () => {
  const { s, calls } = harness((p) => p.endsWith('key-info') ? json(KEY_INFO) : json({ success: false }, 429))
  assertEquals(await s.findWorkEmail(URL_A), { kind: 'unavailable', reason: 'rate_limited', status: 429 })
  assertEquals(calls.length, 1 + 3)
  assertEquals(s.unavailableReason, null)
})

Deno.test('5xx: retried, then server_error', async () => {
  const { s, calls } = harness((p) => p.endsWith('key-info') ? json(KEY_INFO) : json({ success: false }, 503))
  assertEquals(await s.findWorkEmail(URL_A), { kind: 'unavailable', reason: 'server_error', status: 503 })
  assertEquals(calls.length, 4)
})

Deno.test('quota exhausted: 402 stops the session; no further calls', async () => {
  const { s, calls } = harness((p) => p.endsWith('key-info') ? json(KEY_INFO) : json({ success: false, fair_usage: { records_used: 0, records_remaining: 0, request_id: 'r' } }, 402))
  assertEquals(await s.findWorkEmail(URL_A), { kind: 'unavailable', reason: 'exhausted', status: 402 })
  assertEquals(await s.findWorkEmail(URL_A), { kind: 'unavailable', reason: 'exhausted' })
  assertEquals(calls.length, 2)
  assertEquals(await s.canSpend(), false)
})

Deno.test('records countdown: key-info says 1 left → one lookup, then exhausted without calling', async () => {
  const { s, calls } = harness((p) => p.endsWith('key-info') ? json({ ...KEY_INFO, records_remaining: 1 }) : json({ found: true, email: 'a@b.co', fair_usage: { records_used: 1, request_id: 'r' } }))
  assertEquals((await s.findWorkEmail(URL_A)).kind, 'found')
  assertEquals(await s.findWorkEmail(URL_A), { kind: 'unavailable', reason: 'exhausted' })
  assertEquals(calls.length, 2)
  assertEquals(s.recordsUsed, 1)
})

Deno.test('key-info at 0 records: never calls a metered endpoint', async () => {
  const { s, calls } = harness(() => json({ ...KEY_INFO, records_remaining: 0 }))
  assertEquals(await s.findWorkEmail(URL_A), { kind: 'unavailable', reason: 'exhausted' })
  assertEquals(calls.length, 1)
})

Deno.test('maxRecords caps one session below the account balance', async () => {
  const { s, calls } = harness((p) => p.endsWith('key-info') ? json(KEY_INFO) : json({ found: true, email: 'a@b.co', fair_usage: fu(1, 900) }), { maxRecords: 2 })
  for (let i = 0; i < 4; i++) await s.findWorkEmail(URL_A)
  assertEquals(calls.length, 3)
  assertEquals(s.recordsUsed, 2)
})

Deno.test('missing key: no request at all, typed unavailable', async () => {
  const { s, calls } = harness(() => json(KEY_INFO), { key: '' })
  assertEquals(await s.findWorkEmail(URL_A), { kind: 'unavailable', reason: 'no_key' })
  assertEquals(await s.keyInfo(), { kind: 'unavailable', reason: 'no_key' })
  assertEquals(calls.length, 0)
  assertEquals(s.configured, false)
})

Deno.test('invalid key: 401 on key-info disables the session', async () => {
  const { s, calls } = harness(() => json({ success: false, message: 'Invalid API key' }, 401))
  assertEquals(await s.findWorkEmail(URL_A), { kind: 'unavailable', reason: 'invalid_key' })
  assertEquals(await s.findWorkEmail(URL_A), { kind: 'unavailable', reason: 'invalid_key' })
  assertEquals(calls.length, 1)
})

Deno.test('timeout: typed unavailable, not retried (the record may already be counted)', async () => {
  const { s, calls } = harness((p) => {
    if (p.endsWith('key-info')) return json(KEY_INFO)
    throw new DOMException('Signal timed out.', 'TimeoutError')
  })
  assertEquals(await s.findWorkEmail(URL_A), { kind: 'unavailable', reason: 'timeout' })
  assertEquals(calls.length, 2)
  assertEquals(s.unavailableReason, null)
})

Deno.test('key-info outage: session stops for the run without throwing', async () => {
  const { s, calls } = harness(() => { throw new TypeError('connection reset') })
  assertEquals(await s.findWorkEmail(URL_A), { kind: 'unavailable', reason: 'network' })
  assertEquals(calls.length, 1)
})

Deno.test('pacing (real timers): 4 concurrent callers never start more than one request per 250 ms', async () => {
  const { s, calls } = harness((p) => p.endsWith('key-info') ? json(KEY_INFO) : json({ found: false, email: null, fair_usage: fu(0, 969) }), { realTime: true })
  let inFlight = 0
  await Promise.all(Array.from({ length: 4 }, async (_, w) => {
    for (let i = 0; i < 3; i++) {
      inFlight++
      assert(inFlight <= 4)
      await s.findWorkEmail(URL_A)
      inFlight--
      void w
    }
  }))
  assertEquals(calls.length, 13)
  for (let i = 1; i < calls.length; i++) assert(calls[i].at - calls[i - 1].at >= 240, `gap ${i}: ${calls[i].at - calls[i - 1].at}`)
  for (let i = 5; i < calls.length; i++) assert(calls[i].at - calls[i - 5].at >= 1000, 'never 6 starts inside one second (5/s limit)')
})

Deno.test('a bad URL is never sent', async () => {
  const { s, calls } = harness(() => json(KEY_INFO))
  assertEquals(await s.findWorkEmail('https://www.linkedin.com/company/acme'), { kind: 'unavailable', reason: 'bad_request' })
  assertEquals(calls.length, 0)
})

Deno.test('personLinkedinUrl: accepts profile URLs only', () => {
  assertEquals(personLinkedinUrl('https://uk.linkedin.com/in/jane-doe-12ab/?trk=x'), 'https://www.linkedin.com/in/jane-doe-12ab')
  assertEquals(personLinkedinUrl('www.linkedin.com/in/jane'), 'https://www.linkedin.com/in/jane')
  assertEquals(personLinkedinUrl('https://www.linkedin.com/company/acme'), null)
  assertEquals(personLinkedinUrl(''), null)
  assertEquals(personLinkedinUrl(null), null)
})

Deno.test('domainToLinkedin + waterfallIcp: shapes from the docs, one result requested', async () => {
  const { s, calls } = harness((p) => {
    if (p.endsWith('key-info')) return json(KEY_INFO)
    if (p.endsWith('domain-to-linkedin')) return json({ found: true, company_linkedin_url: 'https://www.linkedin.com/company/whitfield', company_name: 'Whitfield PM', other: [], fair_usage: fu(1, 968) })
    return json({
      company_linkedin_url: 'https://www.linkedin.com/company/whitfield', max_results: 1, results_length: 1,
      results: [{ icp: 1, ranking: 1, person: { first_name: 'Dana', last_name: 'Whitfield', full_name: 'Dana Whitfield', headline: 'Owner | @Whitfield PM', linkedin_url: 'https://www.linkedin.com/in/dana', experiences: [{ job_title: 'Owner', job_is_current: true }] } }],
      fair_usage: fu(1, 967),
    })
  })
  assertEquals(await s.domainToLinkedin('whitfieldpm.com'), { kind: 'found', companyLinkedinUrl: 'https://www.linkedin.com/company/whitfield', companyName: 'Whitfield PM' })
  const r = await s.waterfallIcp('https://www.linkedin.com/company/whitfield', DECISION_MAKER_CASCADE, 1)
  assertEquals(r, { kind: 'found', people: [{ name: 'Dana Whitfield', firstName: 'Dana', lastName: 'Whitfield', title: 'Owner', linkedinUrl: 'https://www.linkedin.com/in/dana', tier: 1 }] })
  assertEquals(calls[2].body?.max_results, 1)
  assertEquals((calls[2].body?.cascade as unknown[]).length, 3)
  assertEquals(s.recordsUsed, 2)
})
