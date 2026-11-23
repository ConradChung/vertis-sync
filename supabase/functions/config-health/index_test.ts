// Run: deno test --allow-env config-health/
import { assertEquals } from 'jsr:@std/assert@1'
import { prepareModule } from '../_shared/test_fetch.ts'

prepareModule({})
const { handle, presence } = await import('./index.ts')
const { EDGE_SECRET_NAMES } = await import('./names.ts')

const SVC = 'svc-key-value'
const FAKE_SECRET = 'tg-super-secret-value-123'
const fakeEnv: Record<string, string> = {
  SUPABASE_SERVICE_ROLE_KEY: SVC,
  TELEGRAM_BOT_TOKEN: FAKE_SECRET,
  APIFY_API_TOKEN: 'apify-secret-value-456',
  TELEGRAM_CHAT_ID: '   ',
}
const env = (k: string) => fakeEnv[k]
const req = (headers: Record<string, string> = {}, method = 'GET') => new Request('https://fn.test/config-health', { method, headers })

Deno.test('service caller gets names-only booleans for every listed name', async () => {
  const res = await handle(req({ Authorization: `Bearer ${SVC}` }), env)
  assertEquals(res.status, 200)
  const text = await res.text()
  const body = JSON.parse(text)
  assertEquals(Object.keys(body), ['names'])
  assertEquals(Object.keys(body.names), [...EDGE_SECRET_NAMES])
  for (const v of Object.values(body.names)) assertEquals(typeof v, 'boolean')
  assertEquals(body.names.TELEGRAM_BOT_TOKEN, true)
  assertEquals(body.names.APIFY_API_TOKEN, true)
  assertEquals(body.names.TELEGRAM_CHAT_ID, false) // whitespace only = missing
  assertEquals(body.names.PERPLEXITY_API_KEY, false)
  for (const secret of [FAKE_SECRET, 'apify-secret-value-456', SVC]) assertEquals(text.includes(secret), false)
})

Deno.test('the apikey header also identifies the service caller', async () => {
  const res = await handle(req({ apikey: SVC }), env)
  assertEquals(res.status, 200)
  await res.body?.cancel()
})

Deno.test('non-service callers are refused, with no names or values', async () => {
  const cases: Record<string, string>[] = [{}, { Authorization: 'Bearer anon-key' }, { apikey: 'nope' }]
  for (const h of cases) {
    const res = await handle(req(h), env)
    assertEquals(res.status, 401)
    const text = await res.text()
    assertEquals(text.includes('TELEGRAM_BOT_TOKEN'), false)
    assertEquals(text.includes(FAKE_SECRET), false)
  }
})

Deno.test('other methods are 405', async () => {
  const res = await handle(req({ Authorization: `Bearer ${SVC}` }, 'DELETE'), env)
  assertEquals(res.status, 405)
  await res.body?.cancel()
})

Deno.test('presence: empty and unset are false', () => {
  const e: Record<string, string> = { A: 'x', B: '' }
  assertEquals(presence((k) => e[k], ['A', 'B', 'C']), { A: true, B: false, C: false })
})
