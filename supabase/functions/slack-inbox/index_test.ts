// Run: deno test --allow-env slack-inbox/
import { assertEquals } from 'jsr:@std/assert@1'
import { json, prepareModule, stubFetch } from '../_shared/test_fetch.ts'

prepareModule({
  SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'svc', TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '4242',
  SLACK_BOT_TOKEN: 'xoxb', SLACK_SIGNING_SECRET: 'sig',
})
const { handleFileShared } = await import('./index.ts')

const INGEST = '0f8fad5b-d9cb-469f-a165-70867728950e'

function routes() {
  return stubFetch([
    [(u) => u.startsWith('https://slack.com/api/files.info'), () => json({ ok: true, file: { name: 'leads.csv', url_private_download: 'https://files.slack.test/leads.csv', user: 'U1' } })],
    [(u) => u === 'https://files.slack.test/leads.csv', () => new Response('Name,Email\nA,a@x.com\nB,b@x.com\n')],
    [(u) => u.startsWith('https://db.test/storage/'), () => json({})],
    [(u) => u.startsWith('https://slack.com/api/users.info'), () => json({ ok: true, user: { real_name: 'Pat' } })],
    [(u, m) => u === 'https://db.test/rest/v1/telegram_ingests' && m === 'POST', () => json([{ id: INGEST }], 201)],
    [(u) => u.startsWith('https://slack.com/api/chat.postMessage'), () => json({ ok: true })],
    [(u) => u.startsWith('https://api.telegram.org/'), () => json({ ok: true, result: { message_id: 77 } })],
    [(u) => u.startsWith('https://db.test/rest/v1/rpc/lume_alert_upsert'), () => json(INGEST)],
    [(u, m) => u.startsWith('https://db.test/rest/v1/telegram_ingests?id=eq.') && m === 'PATCH', () => new Response(null, { status: 204 })],
  ])
}

Deno.test('ALERT_CHANNELS unset: the owner prompt is the pre-G4 request byte for byte, its id stored, the feed row keyed by gate', async () => {
  const f = routes()
  try {
    await handleFileShared('F1', 'C1')
    const tg = f.calls.filter((c) => c.url.startsWith('https://api.telegram.org/'))
    assertEquals(tg.map((c) => c.url), ['https://api.telegram.org/bottok/sendMessage'])
    assertEquals(tg[0].body, JSON.stringify({
      chat_id: '4242',
      text: '📥 New CSV from Pat (Slack)\nFile: leads.csv\nRows: 2\nEmail column: Email',
      reply_markup: { inline_keyboard: [[
        { text: '✅ Approve', callback_data: `approve:${INGEST}` },
        { text: '🔎 Approve + Enrich', callback_data: `approve_enrich:${INGEST}` },
        { text: '❌ Deny', callback_data: `deny:${INGEST}` },
      ]] },
    }))
    const patch = f.calls.find((c) => c.method === 'PATCH')!
    assertEquals(JSON.parse(patch.body!), { telegram_message_id: 77 })
    const feed = JSON.parse(f.calls.find((c) => c.url.includes('/rpc/lume_alert_upsert'))!.body!)
    assertEquals([feed.p_dedupe_key, feed.p_severity, feed.p_scope], [`${INGEST}:ingest_approval`, 'urgent', 'validation'])
  } finally { f.restore() }
})

Deno.test('ALERT_CHANNELS=feed: no Telegram request, no message id, the feed row still written', async () => {
  const f = routes()
  Deno.env.set('ALERT_CHANNELS', 'feed')
  try {
    await handleFileShared('F1', 'C1')
    assertEquals(f.calls.filter((c) => c.url.startsWith('https://api.telegram.org/')).length, 0)
    assertEquals(f.calls.filter((c) => c.method === 'PATCH').length, 0)
    assertEquals(f.calls.filter((c) => c.url.includes('/rpc/lume_alert_upsert')).length, 1)
  } finally { Deno.env.delete('ALERT_CHANNELS'); f.restore() }
})
