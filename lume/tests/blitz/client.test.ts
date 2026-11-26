import { describe, expect, it } from 'vitest'
import { BlitzSession } from '@/lib/blitz'

// The Lume twin of supabase/functions/_shared/blitz.ts (full suite in _shared/blitz_test.ts).
const KEY_INFO = { valid: true, records_remaining: 969, max_requests_per_seconds: 5, allowed_apis: [] }
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
const URL_A = 'https://www.linkedin.com/in/dana'

function harness(respond: (path: string, n: number) => Response, key = 'k') {
  let t = 0
  const calls: { path: string; at: number; key: string | null }[] = []
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    calls.push({ path, at: t, key: new Headers(init?.headers).get('x-api-key') })
    return respond(path, calls.length)
  }) as typeof fetch
  const s = new BlitzSession({ apiKey: key, fetch: f, now: () => t, sleep: async (ms) => void (t += ms) })
  return { s, calls }
}

describe('lib/blitz (Lume twin)', () => {
  it('found: key-info once, then the email; records counted', async () => {
    const { s, calls } = harness((p) => (p.endsWith('key-info') ? json(KEY_INFO) : json({ found: true, email: 'Dana@Acme.com', fair_usage: { records_used: 1, records_remaining: 968 } })))
    expect(await s.findWorkEmail(URL_A)).toEqual({ kind: 'found', email: 'dana@acme.com' })
    expect(calls.map((c) => c.path)).toEqual(['/v2/account/key-info', '/v2/enrichment/email'])
    expect(s.recordsUsed).toBe(1)
  })

  it('429 then success: same request again after a wait', async () => {
    const { s, calls } = harness((p, n) => (p.endsWith('key-info') ? json(KEY_INFO) : n === 2 ? json({}, 429) : json({ found: true, email: 'a@b.co', fair_usage: { records_used: 1 } })))
    expect((await s.findWorkEmail(URL_A)).kind).toBe('found')
    expect(calls[2].at - calls[1].at).toBeGreaterThanOrEqual(1000)
  })

  it('exhausted (402) stops the session', async () => {
    const { s, calls } = harness((p) => (p.endsWith('key-info') ? json(KEY_INFO) : json({ fair_usage: { records_used: 0, records_remaining: 0 } }, 402)))
    expect(await s.findWorkEmail(URL_A)).toMatchObject({ kind: 'unavailable', reason: 'exhausted' })
    expect(await s.findWorkEmail(URL_A)).toMatchObject({ kind: 'unavailable', reason: 'exhausted' })
    expect(calls).toHaveLength(2)
  })

  it('missing key: no request; timeout: typed unavailable', async () => {
    const a = harness(() => json(KEY_INFO), '')
    expect(await a.s.findWorkEmail(URL_A)).toEqual({ kind: 'unavailable', reason: 'no_key' })
    expect(a.calls).toHaveLength(0)
    const b = harness((p) => {
      if (p.endsWith('key-info')) return json(KEY_INFO)
      throw new DOMException('timed out', 'TimeoutError')
    })
    expect(await b.s.findWorkEmail(URL_A)).toEqual({ kind: 'unavailable', reason: 'timeout' })
  })
})
