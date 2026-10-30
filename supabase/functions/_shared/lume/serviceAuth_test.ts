import { assertEquals } from 'jsr:@std/assert'
import { isServiceCaller, serviceKeys } from './serviceAuth.ts'

const env = (vars: Record<string, string>) => (k: string) => vars[k]
const req = (headers: Record<string, string>) => new Request('https://x/f', { method: 'POST', headers })

Deno.test('serviceKeys: the legacy key plus every new secret key', () => {
  const keys = serviceKeys(env({ SUPABASE_SERVICE_ROLE_KEY: 'eyJlegacy', SUPABASE_SECRET_KEYS: '{"default":"sb_secret_a","cron":"sb_secret_b"}' }))
  assertEquals(keys.sort(), ['eyJlegacy', 'sb_secret_a', 'sb_secret_b'])
})

Deno.test('serviceKeys: malformed or missing SUPABASE_SECRET_KEYS falls back to the legacy key', () => {
  assertEquals(serviceKeys(env({ SUPABASE_SERVICE_ROLE_KEY: 'eyJlegacy', SUPABASE_SECRET_KEYS: 'not json' })), ['eyJlegacy'])
  assertEquals(serviceKeys(env({ SUPABASE_SERVICE_ROLE_KEY: 'eyJlegacy' })), ['eyJlegacy'])
  assertEquals(serviceKeys(env({ SUPABASE_SECRET_KEYS: '{"default":""}' })), [])
})

Deno.test('isServiceCaller: a new secret key on Bearer or apikey is accepted', async () => {
  const e = env({ SUPABASE_SERVICE_ROLE_KEY: 'eyJlegacy', SUPABASE_SECRET_KEYS: '{"default":"sb_secret_a"}' })
  assertEquals(await isServiceCaller(req({ Authorization: 'Bearer sb_secret_a' }), e), true)
  assertEquals(await isServiceCaller(req({ apikey: 'sb_secret_a' }), e), true)
  assertEquals(await isServiceCaller(req({ Authorization: 'Bearer eyJlegacy' }), e), true)
})

Deno.test('isServiceCaller: anything else is refused, including an empty key set', async () => {
  const e = env({ SUPABASE_SERVICE_ROLE_KEY: 'eyJlegacy', SUPABASE_SECRET_KEYS: '{"default":"sb_secret_a"}' })
  assertEquals(await isServiceCaller(req({ Authorization: 'Bearer sb_publishable_x' }), e), false)
  assertEquals(await isServiceCaller(req({ apikey: 'sb_secret_wrong' }), e), false)
  assertEquals(await isServiceCaller(req({}), e), false)
  assertEquals(await isServiceCaller(req({ Authorization: 'Bearer ' }), env({})), false)
})
