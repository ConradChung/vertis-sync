import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1'
import { alert, type AlertDeps, lumeLink, parseChannels, titleFrom } from './alert.ts'

interface Captured { url: string; init: RequestInit }

function deps(env: Record<string, string | undefined>, opts: { feedStatus?: number; feedThrows?: boolean } = {}) {
  const calls: Captured[] = []
  const logs: string[] = []
  const d: AlertDeps = {
    env: (k) => env[k],
    fetch: (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} })
      if (opts.feedThrows) return Promise.reject(new Error('network down'))
      return Promise.resolve(new Response(opts.feedStatus && opts.feedStatus >= 400 ? 'boom' : null, { status: opts.feedStatus ?? 201 }))
    },
    log: (...a: unknown[]) => { logs.push(a.map(String).join(' ')) },
    waitUntil: undefined,
  }
  return { d, calls, logs }
}

const BASE_ENV = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc' }

Deno.test('parseChannels: missing or empty means telegram,feed', () => {
  assertEquals([...parseChannels(undefined)].sort(), ['feed', 'telegram'])
  assertEquals([...parseChannels('')].sort(), ['feed', 'telegram'])
  assertEquals([...parseChannels('   ')].sort(), ['feed', 'telegram'])
})

Deno.test('parseChannels: comma list, case and spaces tolerated', () => {
  assertEquals([...parseChannels('feed')], ['feed'])
  assertEquals([...parseChannels(' Telegram , FEED ')].sort(), ['feed', 'telegram'])
  assertEquals([...parseChannels('telegram')], ['telegram'])
})

Deno.test('parseChannels: unknown tokens are ignored with a warning', () => {
  const warns: string[] = []
  const got = parseChannels('feed,grok,,slack', (m) => warns.push(String(m)))
  assertEquals([...got], ['feed'])
  assertEquals(warns.length, 2)
  assert(warns[0].includes('grok'))
})

Deno.test('parseChannels: nothing recognised falls back to the default (Telegram stays on)', () => {
  const warns: string[] = []
  assertEquals([...parseChannels('bogus', (m) => warns.push(String(m)))].sort(), ['feed', 'telegram'])
  assert(warns.length >= 1)
})

Deno.test('titleFrom: first non-empty line, markdown stripped', () => {
  assertEquals(titleFrom('\n*Batch* `ready` — [open](https://x)\nsecond'), 'Batch ready — open')
  assertEquals(titleFrom('<b>Order</b> placed'), 'Order placed')
  assertEquals(titleFrom('✅ Done — push_to_instantly'), '✅ Done — push_to_instantly')
  assertEquals(titleFrom('_italic_ and **bold** and ~~gone~~'), 'italic and bold and gone')
  assertEquals(titleFrom('🔍 Email finder 50% (5/10)'), '🔍 Email finder 50% (5/10)')
  assertEquals(titleFrom(''), '')
  assertEquals(titleFrom('x'.repeat(500)).length, 200)
})

Deno.test('lumeLink: absolute with LUME_URL, relative without', () => {
  assertEquals(lumeLink('/validate', () => 'https://lume.app/'), 'https://lume.app/validate')
  assertEquals(lumeLink('/validate', () => undefined), '/validate')
  assertEquals(lumeLink('/validate', () => ''), '/validate')
})

Deno.test('default channels: feed insert attempted and telegram runs, result passed through', async () => {
  const { d, calls } = deps(BASE_ENV)
  let ran = 0
  const out = await alert({ source: 'unit', title: 'T', body: 'B', link: '/validate', scope: 'validation',
    telegram: () => { ran++; return Promise.resolve({ message_id: 42 }) } }, d)
  assertEquals(ran, 1)
  assertEquals(out, { message_id: 42 })
  assertEquals(calls.length, 1)
  assertEquals(calls[0].url, 'https://x.supabase.co/rest/v1/lume_alerts')
  const headers = calls[0].init.headers as Record<string, string>
  assertEquals(headers['apikey'], 'svc')
  assertEquals(headers['Authorization'], 'Bearer svc')
  const row = JSON.parse(String(calls[0].init.body))
  assertEquals(row, { source: 'unit', severity: 'info', title: 'T', body: 'B', link: '/validate', campaign_id: null, scope: 'validation', dedupe_key: null })
})

Deno.test('ALERT_CHANNELS=feed: telegram skipped, feed still inserted, returns undefined', async () => {
  const { d, calls } = deps({ ...BASE_ENV, ALERT_CHANNELS: 'feed' })
  let ran = 0
  const out = await alert({ source: 'unit', title: 'T', telegram: () => { ran++; return Promise.resolve(1) } }, d)
  assertEquals(ran, 0)
  assertEquals(out, undefined)
  assertEquals(calls.length, 1)
})

Deno.test('ALERT_CHANNELS=telegram: the feed is still written (it always is)', async () => {
  const { d, calls } = deps({ ...BASE_ENV, ALERT_CHANNELS: 'telegram' })
  const out = await alert({ source: 'unit', title: 'T', telegram: () => Promise.resolve('sent') }, d)
  assertEquals(out, 'sent')
  assertEquals(calls.length, 1)
})

Deno.test('dedupe_key: insert ignores duplicates on dedupe_key', async () => {
  const { d, calls } = deps(BASE_ENV)
  await alert({ source: 'unit', title: 'Gate', severity: 'urgent', dedupe_key: 'job1:finder' }, d)
  assertEquals(calls[0].url, 'https://x.supabase.co/rest/v1/lume_alerts?on_conflict=dedupe_key')
  const headers = calls[0].init.headers as Record<string, string>
  assert(headers['Prefer'].includes('resolution=ignore-duplicates'))
  assertEquals(JSON.parse(String(calls[0].init.body)).dedupe_key, 'job1:finder')
})

Deno.test('a feed failure (throw or non-2xx) is logged and swallowed; telegram still runs', async () => {
  for (const opts of [{ feedThrows: true }, { feedStatus: 500 }]) {
    const { d, logs } = deps(BASE_ENV, opts)
    const out = await alert({ source: 'unit', title: 'T', telegram: () => Promise.resolve(7) }, d)
    assertEquals(out, 7)
    assert(logs.some((l) => l.includes('lume_alerts')), `expected a log for ${JSON.stringify(opts)}`)
  }
})

Deno.test('missing Supabase env: logged, no throw, telegram still runs', async () => {
  const { d, calls, logs } = deps({})
  const out = await alert({ source: 'unit', title: 'T', telegram: () => Promise.resolve('ok') }, d)
  assertEquals(out, 'ok')
  assertEquals(calls.length, 0)
  assert(logs.length >= 1)
})

Deno.test('a telegram error propagates exactly as before (caller behaviour unchanged)', async () => {
  const { d, calls } = deps(BASE_ENV)
  await assertRejects(() => alert({ source: 'unit', title: 'T', telegram: () => Promise.reject(new Error('tg down')) }, d), Error, 'tg down')
  assertEquals(calls.length, 1)
})

Deno.test('telegram starts without waiting for the feed insert (send timing unchanged)', async () => {
  const order: string[] = []
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const d: AlertDeps = {
    env: (k) => (BASE_ENV as Record<string, string>)[k],
    fetch: async () => { order.push('feed:start'); await gate; order.push('feed:end'); return new Response(null, { status: 201 }) },
    log: () => {},
    waitUntil: undefined,
  }
  const p = alert({ source: 'unit', title: 'T', telegram: () => { order.push('telegram'); release(); return Promise.resolve(1) } }, d)
  assertEquals(await p, 1)
  assertEquals(order, ['feed:start', 'telegram', 'feed:end'])
})

Deno.test('with waitUntil available the feed insert is handed off, not awaited', async () => {
  const handed: Promise<unknown>[] = []
  const { d } = deps(BASE_ENV)
  d.waitUntil = (p) => { handed.push(p) }
  const out = await alert({ source: 'unit', title: 'T', telegram: () => Promise.resolve(3) }, d)
  assertEquals(out, 3)
  assertEquals(handed.length, 1)
  await handed[0]
})
