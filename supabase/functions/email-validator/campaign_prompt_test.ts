import { assert, assertEquals } from 'jsr:@std/assert@1'
import type { AlertDeps } from '../_shared/alert.ts'
import { promptForCampaign } from './campaign_prompt.ts'

const JOB = '7db3d841-252c-4572-95ec-bc110727df8d'
const TOKEN = 'bot-token'
const CHAT = '4242'

// What email-validator sent before G4, byte for byte.
const ORIGINAL_BODY = JSON.stringify({
  chat_id: CHAT,
  text:
    `📤 Push 12 valid leads to Instantly?\nleads.csv\n\n` +
    `Reply to this message with the campaign NAME (partial is fine — I'll match it against your campaign list).`,
  reply_markup: { force_reply: true },
})

function harness(env: Record<string, string>, telegram: { messageId?: number; throws?: boolean } = { messageId: 99 }) {
  const tgCalls: { url: string; init: RequestInit }[] = []
  const feedCalls: string[] = []
  const patches: { jobId: string; body: Record<string, unknown> }[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('https://api.telegram.org/')) {
      tgCalls.push({ url, init: init ?? {} })
      if (telegram.throws) return Promise.reject(new Error('telegram down'))
      return Promise.resolve(Response.json({ ok: true, result: telegram.messageId ? { message_id: telegram.messageId } : {} }))
    }
    throw new Error(`unexpected global fetch ${url}`)
  }) as typeof fetch
  const alertDeps: AlertDeps = {
    env: (k) => ({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc', ...env })[k],
    fetch: (input) => { feedCalls.push(String(input)); return Promise.resolve(new Response(null, { status: 200 })) },
    log: () => {},
  }
  const deps = {
    botToken: TOKEN,
    chatId: CHAT,
    patchJob: (jobId: string, body: Record<string, unknown>) => { patches.push({ jobId, body }); return Promise.resolve() },
    alertDeps,
  }
  const restore = () => { globalThis.fetch = realFetch }
  return { deps, tgCalls, feedCalls, patches, restore }
}

Deno.test('ALERT_CHANNELS unset: the Telegram request is unchanged, then one combined PATCH with the message id', async () => {
  const h = harness({})
  try {
    await promptForCampaign(JOB, 'leads.csv', 12, h.deps)
    assertEquals(h.tgCalls.length, 1)
    assertEquals(h.tgCalls[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`)
    assertEquals(h.tgCalls[0].init.method, 'POST')
    assertEquals(h.tgCalls[0].init.headers, { 'Content-Type': 'application/json' })
    assertEquals(h.tgCalls[0].init.body, ORIGINAL_BODY)
    assertEquals(h.patches, [{ jobId: JOB, body: { instantly_prompt_message_id: 99, instantly_status: 'awaiting_campaign' } }])
    assertEquals(h.feedCalls.length, 1)
  } finally { h.restore() }
})

Deno.test('ALERT_CHANNELS=feed: no Telegram request, the gate still opens (status flips), the feed row is written', async () => {
  const h = harness({ ALERT_CHANNELS: 'feed' })
  try {
    await promptForCampaign(JOB, 'leads.csv', 12, h.deps)
    assertEquals(h.tgCalls.length, 0)
    assertEquals(h.patches, [{ jobId: JOB, body: { instantly_status: 'awaiting_campaign' } }])
    assertEquals(h.feedCalls.length, 1)
  } finally { h.restore() }
})

Deno.test('Telegram failing (throw or no id) still opens the gate, without a message id', async () => {
  for (const tg of [{ throws: true }, {}]) {
    const h = harness({}, tg)
    try {
      await promptForCampaign(JOB, 'leads.csv', 12, h.deps)
      assertEquals(h.patches, [{ jobId: JOB, body: { instantly_status: 'awaiting_campaign' } }])
    } finally { h.restore() }
  }
})

Deno.test('no bot configured: nothing sent to Telegram, gate opens', async () => {
  const h = harness({})
  try {
    await promptForCampaign(JOB, 'leads.csv', 12, { ...h.deps, botToken: '', chatId: '' })
    assertEquals(h.tgCalls.length, 0)
    assertEquals(h.patches[0].body, { instantly_status: 'awaiting_campaign' })
  } finally { h.restore() }
})

Deno.test('a failing PATCH is logged, never thrown', async () => {
  const h = harness({})
  try {
    await promptForCampaign(JOB, 'leads.csv', 12, { ...h.deps, patchJob: () => Promise.reject(new Error('db down')) })
    assert(true)
  } finally { h.restore() }
})
