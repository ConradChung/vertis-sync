import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The real Telegram adapter runs (fetch stubbed); only the DB is faked.
const svc = vi.hoisted(() => ({
  findAwaitingAction: vi.fn(),
  findAwaitingRuleAction: vi.fn(),
  insertPendingAction: vi.fn(),
  setActionMessageId: vi.fn(),
}))
vi.mock('@/lib/db/service', () => ({ ...svc, isDbError: () => false }))
const store = vi.hoisted(() => ({ setActionNotify: vi.fn() }))
vi.mock('@/lib/actions/store', () => store)
vi.mock('@/lib/campaigns/service', () => ({ findAwaitingActionBy: vi.fn().mockResolvedValue(null) }))
const grant = vi.hoisted(() => ({ tryGrantSend: vi.fn() }))
vi.mock('@/lib/actions/grant', () => grant)
vi.mock('@/lib/supabase/service', async () => (await import('../stubs/feed')).serviceModule)
vi.mock('@/lib/webhooks/deliver', () => ({ pushForItem: vi.fn() }))
vi.mock('@/lib/slack/hooks', () => ({ slackOnAction: vi.fn() }))

import { createAction } from '@/lib/actions/create'

const TOKEN = '987654:fake-bot-token-value'
const fetchMock = vi.fn<typeof fetch>()
const pause = () => createAction('pause_campaign', { campaign_id: 'c-1', summary: 'Pause' }, 'user')
const patchOf = () => store.setActionNotify.mock.calls[0]

beforeEach(() => {
  vi.resetAllMocks()
  vi.unstubAllEnvs()
  vi.stubEnv('TELEGRAM_BOT_TOKEN', TOKEN)
  vi.stubEnv('TELEGRAM_CHAT_ID', '42')
  vi.stubEnv('ALERT_CHANNELS', '')
  vi.stubEnv('LUME_URL', 'https://lume.example.com')
  svc.insertPendingAction.mockImplementation(async (r: Record<string, unknown>) => ({ id: 'a-1', status: 'awaiting', telegram_message_id: null, ...r }))
  svc.setActionMessageId.mockResolvedValue(undefined)
  store.setActionNotify.mockResolvedValue(undefined)
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.unstubAllGlobals())

describe('createAction records why the Telegram prompt was or was not sent', () => {
  it('missing token → skipped "missing token", no network call', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '')
    const row = await pause()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(patchOf()).toEqual(['a-1', { notify_status: 'skipped', notify_error: 'missing token', notified_at: null }])
    expect(row).toMatchObject({ notify_status: 'skipped', notify_error: 'missing token', telegram_message_id: null })
  })

  it('missing chat id → skipped "missing chat id"', async () => {
    vi.stubEnv('TELEGRAM_CHAT_ID', '')
    await pause()
    expect(patchOf()).toEqual(['a-1', { notify_status: 'skipped', notify_error: 'missing chat id', notified_at: null }])
  })

  it('ALERT_CHANNELS without telegram → skipped "telegram channel disabled (ALERT_CHANNELS)"', async () => {
    vi.stubEnv('ALERT_CHANNELS', 'feed')
    await pause()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(patchOf()).toEqual(['a-1', { notify_status: 'skipped', notify_error: 'telegram channel disabled (ALERT_CHANNELS)', notified_at: null }])
  })

  it('API error → failed "Telegram 401: Unauthorized", never the token', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: false, description: 'Unauthorized' }), { status: 401 }))
    await pause()
    expect(patchOf()).toEqual(['a-1', { notify_status: 'failed', notify_error: 'Telegram 401: Unauthorized', notified_at: null }])
    expect(svc.setActionMessageId).not.toHaveBeenCalled()
  })

  it('network exception → failed, token and token URL scrubbed, clipped to 300', async () => {
    fetchMock.mockRejectedValue(new Error(`connect failed https://api.telegram.org/bot${TOKEN}/sendMessage ${'x'.repeat(400)} ${TOKEN}`))
    await pause()
    const [, patch] = patchOf()
    expect(patch.notify_status).toBe('failed')
    expect(patch.notify_error).toMatch(/^Telegram request failed: connect failed <telegram api>/)
    expect(patch.notify_error.length).toBeLessThanOrEqual(300)
    expect(JSON.stringify(store.setActionNotify.mock.calls)).not.toContain(TOKEN)
  })

  it('success → sent with notified_at, and telegram_message_id stored as before', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), { status: 200 }))
    const row = await pause()
    const [id, patch] = patchOf()
    expect(id).toBe('a-1')
    expect(patch).toMatchObject({ notify_status: 'sent', notify_error: null })
    expect(Number.isNaN(Date.parse(patch.notified_at))).toBe(false)
    expect(svc.setActionMessageId).toHaveBeenCalledWith('a-1', 77)
    expect(row).toMatchObject({ notify_status: 'sent', telegram_message_id: 77 })
  })

  it('a failed record never throws into the caller', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '')
    store.setActionNotify.mockRejectedValue(new Error('db down'))
    const row = await pause()
    expect(row.id).toBe('a-1')
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('could not record notify_status for a-1'), 'db down')
  })

  it('an auto-approved reply records its notice too', async () => {
    vi.stubEnv('TELEGRAM_CHAT_ID', '')
    const payload = { eaccount: 'me@x.com', reply_to_uuid: 'u-1', body: 'hi', campaign_id: 'c-1', lead_email: 'ada@acme.com', verdict: 'GOOD', summary: 'Send reply' }
    grant.tryGrantSend.mockResolvedValue({ granted: true, row: { id: 'a-1', kind: 'send_reply', status: 'approved', decided_via: 'grant', payload } })
    const row = await createAction('send_reply', payload, 'user')
    expect(patchOf()).toEqual(['a-1', { notify_status: 'skipped', notify_error: 'missing chat id', notified_at: null }])
    expect(row).toMatchObject({ status: 'approved', notify_status: 'skipped' })
  })
})
