import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendActionPrompt, sendGatePing, sendMessage } from '@/lib/adapters/telegram'
import type { PendingActionRow } from '@/lib/db/types'

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e'

const action: PendingActionRow = {
  id: ID, kind: 'assign_leads', payload: { summary: '40 → Kaspen SF' }, risk: 'high', status: 'awaiting',
  claim_status: 'awaiting', requested_by: 'rule', agent_run_id: null, rule_id: null, telegram_message_id: null,
  decided_via: null, decided_at: null, executed_at: null, result: null, error: null,
  created_at: '2026-10-14T20:00:00Z', updated_at: '2026-10-14T20:00:00Z',
}

describe('telegram adapter — unconfigured', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN
    delete process.env.TELEGRAM_CHAT_ID
    process.env.LUME_URL = 'https://lume.example.com'
    warn.mockClear()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('skips with a warning and never calls the network', async () => {
    const text = 'hello there, this is a fairly long message that will be truncated in the log line'
    const r = await sendMessage(text)
    expect(r).toEqual({ ok: false, skipped: true })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(`[telegram] not configured — skipped: ${text.slice(0, 60)}`)
    expect(text.length).toBeGreaterThan(60)
  })

  it('sendGatePing with LUME_URL set carries the link and no linkOmitted flag', async () => {
    const r = await sendGatePing('stall', ID, 'leads.csv')
    expect(r).toEqual({ ok: false, skipped: true })
    expect(warn.mock.calls.some((c) => String(c[0]).includes('LUME_URL unset'))).toBe(false)
  })

  it('sendGatePing / sendActionPrompt with LUME_URL unset omit the link and say so', async () => {
    delete process.env.LUME_URL
    const ping = await sendGatePing('stall', ID, 'leads.csv')
    expect(ping).toEqual({ ok: false, skipped: true, linkOmitted: true })
    const prompt = await sendActionPrompt(action)
    expect(prompt).toEqual({ ok: false, skipped: true, linkOmitted: true })
    const unsetWarnings = warn.mock.calls.filter((c) => c[0] === '[telegram] LUME_URL unset — deep link omitted')
    expect(unsetWarnings).toHaveLength(2)
  })
})

describe('telegram adapter — configured', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const fetchMock = vi.fn<typeof fetch>()
  const TOKEN = '123456:ABC-secret-token'

  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = TOKEN
    process.env.TELEGRAM_CHAT_ID = '42'
    process.env.LUME_URL = 'https://lume.example.com'
    error.mockClear()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('posts sendMessage to the bot URL and returns the message id', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), { status: 200 }))
    const r = await sendGatePing('stall', ID, 'leads.csv')
    expect(r).toEqual({ ok: true, messageId: 77 })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`)
    const body = JSON.parse(String(init?.body))
    expect(body).toMatchObject({ chat_id: '42', link_preview_options: { is_disabled: true } })
    expect(body.text).toBe(`🔗 leads.csv — open in Lume\nhttps://lume.example.com/validate?gate=stall:${ID}`)
  })

  it('redacts the bot token from logged errors', async () => {
    fetchMock.mockRejectedValue(new Error(`fetch failed for https://api.telegram.org/bot${TOKEN}/sendMessage`))
    const r = await sendMessage('x')
    expect(r.ok).toBe(false)
    if (!r.ok && !r.skipped) {
      expect(r.error).not.toContain(TOKEN)
      expect(r.error).toContain('<token>')
    }
    const logged = error.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).not.toContain(TOKEN)
    expect(logged).toContain('<token>')
  })

  it('redacts the token from an API error description too', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: false, description: `Unauthorized: bot${TOKEN}` }), { status: 401 })
    )
    const r = await sendMessage('x')
    expect(r).toEqual({ ok: false, error: 'Unauthorized: bot<token>' })
  })
})
