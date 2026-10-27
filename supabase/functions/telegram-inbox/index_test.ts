// Run: deno test --allow-env telegram-inbox/
import { assertEquals } from 'jsr:@std/assert@1'
import { json, prepareModule, stubFetch } from '../_shared/test_fetch.ts'

prepareModule({
  SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'svc', TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '4242',
  TELEGRAM_WEBHOOK_SECRET: 'wh',
})
const { handleDocument } = await import('./index.ts')

const INGEST = '0f8fad5b-d9cb-469f-a165-70867728950e'
// deno-lint-ignore no-explicit-any
const message = { message_id: 5, chat: { id: 999 }, from: { username: 'pat' }, document: { file_id: 'FID', file_name: 'leads.csv' } } as any

function routes() {
  return stubFetch([
    [(u) => u === 'https://api.telegram.org/bottok/getFile', () => json({ ok: true, result: { file_path: 'docs/leads.csv' } })],
    [(u) => u === 'https://api.telegram.org/file/bottok/docs/leads.csv', () => new Response('Name,Email\nA,a@x.com\n')],
    [(u) => u.startsWith('https://db.test/storage/'), () => json({})],
    [(u, m) => u === 'https://db.test/rest/v1/telegram_ingests' && m === 'POST', () => json([{ id: INGEST }], 201)],
    [(u) => u === 'https://api.telegram.org/bottok/sendMessage', () => json({ ok: true, result: { message_id: 88 } })],
    [(u) => u.startsWith('https://db.test/rest/v1/rpc/lume_alert_upsert'), () => json(INGEST)],
    [(u, m) => u.startsWith('https://db.test/rest/v1/telegram_ingests?id=eq.') && m === 'PATCH', () => new Response(null, { status: 204 })],
  ])
}

const sends = (f: ReturnType<typeof routes>) => f.calls.filter((c) => c.url === 'https://api.telegram.org/bottok/sendMessage')

Deno.test('ALERT_CHANNELS unset: sender ack + the owner approval prompt, both byte-identical to pre-G4; id stored', async () => {
  const f = routes()
  try {
    await handleDocument(message)
    const s = sends(f)
    assertEquals(s.map((c) => c.body), [
      JSON.stringify({ chat_id: '999', text: 'Got your file — checking with the owner. Hang tight.' }),
      JSON.stringify({
        chat_id: '4242',
        text: '📥 New CSV from @pat\nFile: leads.csv\nRows: 1\nEmail column: Email',
        reply_markup: { inline_keyboard: [[
          { text: '✅ Approve', callback_data: `approve:${INGEST}` },
          { text: '🔎 Approve + Enrich', callback_data: `approve_enrich:${INGEST}` },
          { text: '❌ Deny', callback_data: `deny:${INGEST}` },
        ]] },
      }),
    ])
    assertEquals(JSON.parse(f.calls.find((c) => c.method === 'PATCH')!.body!), { telegram_message_id: 88 })
    const feed = JSON.parse(f.calls.find((c) => c.url.includes('/rpc/lume_alert_upsert'))!.body!)
    assertEquals([feed.p_dedupe_key, feed.p_mode], [`${INGEST}:ingest_approval`, 'reopen'])
  } finally { f.restore() }
})

Deno.test('ALERT_CHANNELS=feed: the sender is still answered (intake untouched), the owner prompt goes to the feed only', async () => {
  const f = routes()
  Deno.env.set('ALERT_CHANNELS', 'feed')
  try {
    await handleDocument(message)
    assertEquals(sends(f).map((c) => JSON.parse(c.body!).chat_id), ['999'])
    assertEquals(f.calls.filter((c) => c.method === 'PATCH').length, 0)
    assertEquals(f.calls.filter((c) => c.url.includes('/rpc/lume_alert_upsert')).length, 1)
  } finally { Deno.env.delete('ALERT_CHANNELS'); f.restore() }
})
