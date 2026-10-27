// Run: deno test --allow-env leadsfriday-order/
import { assertEquals } from 'jsr:@std/assert@1'
import { json, prepareModule, stubFetch } from '../_shared/test_fetch.ts'

prepareModule({ SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'svc', TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '4242' })
const { ingest } = await import('./index.ts')

const ORDER = '3f0c8a52-6a55-4c1b-9d7e-2f8a1c0b9e11'
const INGEST = '0f8fad5b-d9cb-469f-a165-70867728950e'
const order = {
  id: ORDER, apollo_url: 'https://app.apollo.io/#/people', contact_count: 500, status: 'ordered', leadsfriday_order_id: 321,
  leadsfriday_status: 'pending', telegram_message_id: 55, created_at: '', updated_at: '',
}
const st = { status: 'delivered', download_url: 'https://lf.test/dl.csv', delivered_count: 2 }

function routes() {
  return stubFetch([
    [(u) => u === 'https://lf.test/dl.csv', () => new Response('Name,Email\nA,a@x.com\nB,b@x.com\n')],
    [(u) => u.startsWith('https://db.test/storage/'), () => json({})],
    [(u, m) => u.startsWith('https://db.test/rest/v1/apollo_orders?') && m === 'PATCH', () => json([{ id: ORDER }])],
    [(u, m) => u === 'https://db.test/rest/v1/telegram_ingests' && m === 'POST', () => json([{ id: INGEST }], 201)],
    [(u, m) => u.startsWith('https://db.test/rest/v1/telegram_ingests?id=eq.') && m === 'PATCH', () => new Response(null, { status: 204 })],
    [(u) => u.startsWith('https://api.telegram.org/bottok/'), () => json({ ok: true, result: { message_id: 91 } })],
    [(u) => u.startsWith('https://db.test/rest/v1/rpc/lume_alert_upsert'), () => json(INGEST)],
  ])
}
const tgCalls = (f: ReturnType<typeof routes>) => f.calls.filter((c) => c.url.startsWith('https://api.telegram.org/'))

Deno.test('ALERT_CHANNELS unset: delivered prompt + receipt edit are the pre-G4 requests byte for byte', async () => {
  const f = routes()
  try {
    // deno-lint-ignore no-explicit-any
    await ingest(order as any, st as any)
    const tg = tgCalls(f)
    assertEquals(tg.map((c) => c.url), ['https://api.telegram.org/bottok/sendMessage', 'https://api.telegram.org/bottok/editMessageReplyMarkup'])
    assertEquals(tg[0].body, JSON.stringify({
      chat_id: '4242',
      text: '📥 Leadsfriday delivered order #321\nFile: leadsfriday-321.csv\nRows: 2\nEmail column: Email',
      reply_markup: { inline_keyboard: [[
        { text: '✅ Approve', callback_data: `approve:${INGEST}` },
        { text: '🔎 Approve + Enrich', callback_data: `approve_enrich:${INGEST}` },
        { text: '❌ Deny', callback_data: `deny:${INGEST}` },
      ]] },
      disable_web_page_preview: true,
    }))
    assertEquals(tg[1].body, JSON.stringify({ chat_id: '4242', message_id: 55, reply_markup: { inline_keyboard: [] } }))
    const idPatch = f.calls.find((c) => c.url.startsWith('https://db.test/rest/v1/telegram_ingests?id=eq.'))!
    assertEquals(JSON.parse(idPatch.body!), { telegram_message_id: 91 })
    const feed = JSON.parse(f.calls.find((c) => c.url.includes('/rpc/lume_alert_upsert'))!.body!)
    assertEquals([feed.p_dedupe_key, feed.p_scope, feed.p_severity], [`${INGEST}:ingest_approval`, 'validation', 'urgent'])
  } finally { f.restore() }
})

Deno.test('ALERT_CHANNELS=feed: no prompt send and no message id; the order still moves to ingested', async () => {
  const f = routes()
  Deno.env.set('ALERT_CHANNELS', 'feed')
  try {
    // deno-lint-ignore no-explicit-any
    await ingest(order as any, st as any)
    assertEquals(tgCalls(f).map((c) => c.url), ['https://api.telegram.org/bottok/editMessageReplyMarkup'])
    assertEquals(f.calls.filter((c) => c.url.startsWith('https://db.test/rest/v1/telegram_ingests?id=eq.')).length, 0)
    const ingested = f.calls.filter((c) => c.url.includes('status=eq.delivered')).map((c) => JSON.parse(c.body!))
    assertEquals(ingested, [{ status: 'ingested', ingest_id: INGEST }])
  } finally { Deno.env.delete('ALERT_CHANNELS'); f.restore() }
})
