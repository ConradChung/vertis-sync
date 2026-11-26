// Run: deno test --allow-env contact-email-finder/
// Routing: LinkedIn URL → Blitz first; Blitz miss / exhausted / no key →
// connector-os, unchanged; found addresses stay 'pending' for email-validator.
import { assert, assertEquals } from 'jsr:@std/assert@1'
import { json, prepareModule, stubFetch } from '../_shared/test_fetch.ts'

prepareModule({
  SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'svc', CONNECTOR_OS_API_KEY: 'cos', TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '',
  ALERT_CHANNELS: 'feed',
})
Deno.env.set('ALERT_CHANNELS', 'feed')
const { processJob } = await import('./index.ts')

const JOB = 'job-1'
interface Row { id: string; row_index: number; email: string; status: string; row_data: Record<string, unknown>; validation_result: Record<string, unknown> | null }

const HEADERS = ['First Name', 'Last Name', 'Company Domain', 'Person Linkedin Url', 'Company Linkedin Url']
function row(i: number, data: Partial<Record<string, string>>): Row {
  return {
    id: `r${i}`, row_index: i, email: '', status: 'pending', validation_result: null,
    row_data: { 'First Name': `F${i}`, 'Last Name': `L${i}`, 'Company Domain': `co${i}.com`, 'Person Linkedin Url': '', 'Company Linkedin Url': `https://www.linkedin.com/company/co${i}`, ...data },
  }
}

/** In-memory validation_rows / validation_jobs behind PostgREST-shaped URLs, plus Blitz and connector-os. */
function world(rows: Row[], blitz: (url: string, n: number) => Response, opts: { keyInfo?: Record<string, unknown> } = {}) {
  const blitzStarts: number[] = []
  let blitzEmailCalls = 0
  const f = stubFetch([
    [(u) => u.startsWith('https://api.blitz-api.ai/v2/account/key-info'), () => json(opts.keyInfo ?? { valid: true, records_remaining: 969, max_requests_per_seconds: 5, allowed_apis: [] })],
    [(u) => u.startsWith('https://api.blitz-api.ai/v2/enrichment/email'), (_u, body) => {
      blitzStarts.push(performance.now())
      return blitz(JSON.parse(body ?? '{}').person_linkedin_url, ++blitzEmailCalls)
    }],
    [(u) => u.startsWith('https://api.connector-os.com/'), (_u, body) => {
      const b = JSON.parse(body ?? '{}')
      return b.firstName === 'NoHit' ? json({}, 404) : json({ email: `${b.firstName.toLowerCase()}@${b.domain}`, status: 'found', found_via: 'pattern' })
    }],
    [(u) => u.startsWith('https://db.test/rest/v1/rpc/lume_alert_upsert'), () => json('a1')],
    [(u) => u.startsWith('https://db.test/functions/v1/'), () => json({ ok: true })],
    [(u, m) => u.startsWith('https://db.test/rest/v1/validation_jobs') && m === 'PATCH', (u) =>
      u.includes('status=in.') ? json([{ id: JOB }]) : new Response(null, { status: 204 })],
    [(u, m) => u.startsWith('https://db.test/rest/v1/validation_jobs') && m === 'GET', (u) =>
      u.includes('select=status') ? json([{ status: 'processing' }])
        : json([{ id: JOB, filename: 'list.csv', column_order: HEADERS, emails_found: 0, emails_not_found: 0 }])],
    [(u, m) => u.startsWith('https://db.test/rest/v1/validation_rows?id=eq.') && m === 'PATCH', (u, body) => {
      const r = rows.find((x) => x.id === new URL(u).searchParams.get('id')!.slice(3))!
      Object.assign(r, JSON.parse(body ?? '{}'))
      return new Response(null, { status: 204 })
    }],
    [(u, m) => u.startsWith('https://db.test/rest/v1/validation_rows?') && m === 'GET', (u) => {
      const q = new URL(u).searchParams
      let out = rows.filter((r) => r.status === 'pending')
      if (q.get('email') === 'eq.') out = out.filter((r) => r.email === '')
      if (q.get('validation_result->>found_by')) out = rows.filter((r) => r.validation_result?.found_by === 'blitz')
      out = out.sort((a, b) => a.row_index - b.row_index).slice(0, Number(q.get('limit') ?? 1e9))
      return json(out.map((r) => ({ ...r })))
    }],
  ])
  return { f, blitzStarts, blitzEmailCalls: () => blitzEmailCalls }
}

const callsTo = (f: ReturnType<typeof stubFetch>, prefix: string) => f.calls.filter((c) => c.url.startsWith(prefix))
const blitzFound = (email: string) => json({ found: true, email, fair_usage: { records_used: 1, records_remaining: 900, request_id: 'x' } })
const blitzMiss = () => json({ found: false, email: null, fair_usage: { records_used: 0, records_remaining: 900, request_id: 'x' } })

Deno.test('LinkedIn URL → Blitz; miss → connector-os; no URL → connector-os only; validator still gets every found address', async () => {
  Deno.env.set('BLITZ_API_KEY', 'test-blitz')
  const rows = [
    row(1, { 'Person Linkedin Url': 'https://www.linkedin.com/in/one' }),
    row(2, { 'Person Linkedin Url': 'https://www.linkedin.com/in/two' }),
    row(3, {}),
    row(4, { 'First Name': 'NoHit', 'Person Linkedin Url': 'linkedin.com/in/four' }),
  ]
  const w = world(rows, (url) => url.endsWith('/one') ? blitzFound('one@co1.com') : blitzMiss())
  try {
    await processJob(JOB)
    assertEquals(w.blitzEmailCalls(), 3) // rows 1, 2, 4; never row 3 and never the company page
    const cos = callsTo(w.f, 'https://api.connector-os.com/').map((c) => JSON.parse(c.body!).firstName)
    assertEquals(cos, ['F2', 'F3', 'NoHit']) // row 1 was found by Blitz, so connector-os never saw it
    assertEquals(rows.map((r) => [r.id, r.status, r.email, r.validation_result?.found_by ?? null, r.validation_result?.blitz ?? null]), [
      ['r1', 'pending', 'one@co1.com', 'blitz', null],
      ['r2', 'pending', 'f2@co2.com', 'connector-os', 'miss'],
      ['r3', 'pending', 'f3@co3.com', 'connector-os', null],
      ['r4', 'no_email', '', null, 'miss'],
    ])
    assertEquals(callsTo(w.f, 'https://db.test/functions/v1/email-validator').length, 1)
    const done = callsTo(w.f, 'https://db.test/rest/v1/rpc/lume_alert_upsert').map((c) => JSON.parse(c.body!)).find((b) => String(JSON.stringify(b)).includes('complete'))
    assert(JSON.stringify(done).includes('Blitz: 1 found (1 records used)'))
    // the API key only ever travels in the header
    assert(!w.f.calls.some((c) => (c.body ?? '').includes('test-blitz')))
  } finally {
    w.f.restore()
  }
})

Deno.test('Blitz exhausted (key-info 0 records) → every row goes to connector-os, no metered Blitz call', async () => {
  Deno.env.set('BLITZ_API_KEY', 'test-blitz')
  const rows = [row(1, { 'Person Linkedin Url': 'https://www.linkedin.com/in/one' }), row(2, { 'Person Linkedin Url': 'https://www.linkedin.com/in/two' })]
  const w = world(rows, () => blitzFound('x@y.com'), { keyInfo: { valid: true, records_remaining: 0 } })
  try {
    await processJob(JOB)
    assertEquals(w.blitzEmailCalls(), 0)
    assertEquals(callsTo(w.f, 'https://api.connector-os.com/').length, 2)
    assertEquals(rows.map((r) => r.validation_result?.found_by), ['connector-os', 'connector-os'])
  } finally {
    w.f.restore()
  }
})

Deno.test('Blitz runs out mid-run (402) → the rest fall back to connector-os, the job finishes', async () => {
  Deno.env.set('BLITZ_API_KEY', 'test-blitz')
  const rows = [1, 2, 3, 4, 5, 6].map((i) => row(i, { 'Person Linkedin Url': `https://www.linkedin.com/in/p${i}` }))
  const w = world(rows, (_u, n) => n === 1 ? blitzFound('p1@co1.com') : json({ success: false, fair_usage: { records_used: 0, records_remaining: 0, request_id: 'x' } }, 402))
  try {
    await processJob(JOB)
    assert(w.blitzEmailCalls() <= 5, 'stops asking once Blitz says the quota is gone')
    assertEquals(rows.filter((r) => r.validation_result?.found_by === 'blitz').length, 1)
    assertEquals(rows.filter((r) => r.validation_result?.found_by === 'connector-os').length, 5)
    assert(rows.every((r) => r.email !== ''))
  } finally {
    w.f.restore()
  }
})

Deno.test('no BLITZ_API_KEY → connector-os exactly as before, Blitz never called', async () => {
  Deno.env.delete('BLITZ_API_KEY')
  const rows = [row(1, { 'Person Linkedin Url': 'https://www.linkedin.com/in/one' })]
  const w = world(rows, () => blitzFound('x@y.com'))
  try {
    await processJob(JOB)
    assertEquals(callsTo(w.f, 'https://api.blitz-api.ai/').length, 0)
    assertEquals(rows[0].validation_result, { found_by: 'connector-os', found_via: 'pattern', finder_status: 'found' })
  } finally {
    w.f.restore()
  }
})

Deno.test('pacing: 12 LinkedIn rows, 4 in flight, never more than 5 Blitz starts in any second', async () => {
  Deno.env.set('BLITZ_API_KEY', 'test-blitz')
  const rows = Array.from({ length: 12 }, (_, i) => row(i + 1, { 'Person Linkedin Url': `https://www.linkedin.com/in/p${i + 1}` }))
  let inFlight = 0
  let maxInFlight = 0
  const w = world(rows, () => {
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    queueMicrotask(() => inFlight--)
    return blitzFound('p@co.com')
  })
  try {
    await processJob(JOB)
    assertEquals(w.blitzStarts.length, 12)
    for (let i = 5; i < w.blitzStarts.length; i++) assert(w.blitzStarts[i] - w.blitzStarts[i - 5] >= 1000, `6 starts within a second at ${i}`)
    assert(maxInFlight <= 4)
    assertEquals(callsTo(w.f, 'https://api.connector-os.com/').length, 0)
  } finally {
    w.f.restore()
  }
})
