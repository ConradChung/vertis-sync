// Run: deno test --allow-env signal-comments/
// The tick itself is tested with fakes in _shared/signal/tick_test.ts; this covers the HTTP edge.
import { assertEquals } from 'jsr:@std/assert@1'
import { json, prepareModule, stubFetch } from '../_shared/test_fetch.ts'

prepareModule({ SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'svc', APIFY_API_TOKEN: 'apify-tok' })
const { handle } = await import('./index.ts')

const req = (body: unknown, key = 'svc') =>
  new Request('https://fn.test/signal-comments', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: JSON.stringify(body) })

Deno.test('auth: non-service callers are refused', async () => {
  const res = await handle(req({ action: 'tick' }, 'anon'))
  assertEquals(res.status, 401)
})

Deno.test('unknown action → 400', async () => {
  const res = await handle(req({ action: 'nope' }))
  assertEquals(res.status, 400)
})

Deno.test('lease held → { ok, skipped: leased }, nothing else called', async () => {
  const stub = stubFetch([[(u) => u.includes('/rpc/signal_claim_tick'), () => json(null)]])
  try {
    const res = await handle(req({ action: 'tick' }))
    assertEquals(await res.json(), { ok: true, skipped: 'leased' })
    assertEquals(stub.calls.length, 1)
    assertEquals(stub.calls[0].url, 'https://db.test/rest/v1/rpc/signal_claim_tick')
  } finally {
    stub.restore()
  }
})
