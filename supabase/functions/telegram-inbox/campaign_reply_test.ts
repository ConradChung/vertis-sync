// Run: deno test --allow-env telegram-inbox/
// The campaign-name reply only writes while the job still waits for a
// campaign: a Lume pick in between is not overwritten, and the reply says so.
import { assertEquals } from 'jsr:@std/assert@1'
import { json, prepareModule, stubFetch } from '../_shared/test_fetch.ts'

prepareModule({
  SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'svc', TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '4242',
  TELEGRAM_WEBHOOK_SECRET: 'wh', INSTANTLY_API_KEY: 'ik',
})
const { handleCampaignNameReply } = await import('./index.ts')

const JOB = '7db3d841-252c-4572-95ec-bc110727df8d'
const job = { id: JOB, instantly_status: 'awaiting_campaign', filename: 'f.csv', valid_count: 10 }

function routes(patchRows: unknown[], search: unknown[]) {
  return stubFetch([
    [(u, m) => u.startsWith('https://db.test/rest/v1/validation_jobs?instantly_prompt_message_id=eq.77') && m === 'GET', () => json([job])],
    [(u) => u.startsWith('https://api.instantly.ai/api/v2/campaigns?limit=50&search='), () => json({ items: search })],
    [(u, m) => u.startsWith(`https://db.test/rest/v1/validation_jobs?id=eq.${JOB}&instantly_status=in.(awaiting_campaign,choosing_campaign)`) && m === 'PATCH', () => json(patchRows)],
    [(u) => u === 'https://api.telegram.org/bottok/sendMessage', () => json({ ok: true, result: { message_id: 90 } })],
  ])
}
const sends = (f: ReturnType<typeof routes>) => f.calls.filter((c) => c.url === 'https://api.telegram.org/bottok/sendMessage').map((c) => JSON.parse(c.body!).text)

Deno.test('a resolved name whose job Lume already moved on: no overwrite, the reply says it was set in Lume', async () => {
  const f = routes([], [{ id: 'c1', name: 'Kaspen R3', status: 1 }])
  try {
    assertEquals(await handleCampaignNameReply('Kaspen R3', 77), true)
    const patch = f.calls.find((c) => c.method === 'PATCH')!
    assertEquals(patch.url, `https://db.test/rest/v1/validation_jobs?id=eq.${JOB}&instantly_status=in.(awaiting_campaign,choosing_campaign)`)
    assertEquals(sends(f), ['That campaign was already set in Lume.'])
  } finally {
    f.restore()
  }
})

Deno.test('several matches after Lume picked: no candidate list is sent', async () => {
  const f = routes([], [{ id: 'c1', name: 'Scaleport - R3', status: 1 }, { id: 'c2', name: 'Scaleport - M', status: 0 }])
  try {
    await handleCampaignNameReply('scaleport', 77)
    assertEquals(sends(f), ['That campaign was already set in Lume.'])
  } finally {
    f.restore()
  }
})

Deno.test('several matches while still waiting: the same candidate prompt as before', async () => {
  const f = routes([{ id: JOB }], [{ id: 'c1', name: 'Scaleport - R3', status: 1 }, { id: 'c2', name: 'Scaleport - M', status: 0 }])
  try {
    await handleCampaignNameReply('scaleport', 77)
    const body = JSON.parse(f.calls.find((c) => c.url === 'https://api.telegram.org/bottok/sendMessage')!.body!)
    assertEquals(body, {
      chat_id: '4242',
      text: '2 campaigns match "scaleport" — which one?',
      reply_markup: { inline_keyboard: [
        [{ text: 'Scaleport - R3 (active)', callback_data: `camp_pick:${JOB}:0` }],
        [{ text: 'Scaleport - M (draft)', callback_data: `camp_pick:${JOB}:1` }],
      ] },
    })
  } finally {
    f.restore()
  }
})
