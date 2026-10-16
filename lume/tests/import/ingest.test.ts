import { beforeEach, describe, expect, it, vi } from 'vitest'

const svc = vi.hoisted(() => ({
  insertIngest: vi.fn(),
  setIngestMessageId: vi.fn(),
  insertApolloOrder: vi.fn(),
  setApolloOrderMessageId: vi.fn(),
  logEvent: vi.fn(),
}))
vi.mock('@/lib/db/service', () => svc)
const sendMessage = vi.hoisted(() => vi.fn())
vi.mock('@/lib/adapters/telegram', () => ({ sendMessage }))
const storage = vi.hoisted(() => ({ uploadCsv: vi.fn(), removeObject: vi.fn() }))
vi.mock('@/lib/import/storage', () => storage)

import { createApolloOrder, createIngest } from '@/lib/import/ingest'

const ID = '7db3d841-252c-4572-95ec-bc110727df8d'
const enc = (s: string) => new TextEncoder().encode(s)

beforeEach(() => {
  for (const f of [...Object.values(svc), ...Object.values(storage), sendMessage]) f.mockReset()
  svc.insertIngest.mockImplementation(async (row: Record<string, unknown>) => ({ id: ID, telegram_message_id: null, ...row }))
  svc.insertApolloOrder.mockImplementation(async (url: string) => ({ id: ID, apollo_url: url, status: 'awaiting_count', telegram_message_id: null }))
  svc.logEvent.mockResolvedValue(null)
  process.env.TELEGRAM_CHAT_ID = '4242'
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('createIngest', () => {
  it('uploads to raw-uploads/lume/<uuid>.csv, inserts an awaiting_approval lume ingest, sends the prompt, stores the message id', async () => {
    sendMessage.mockResolvedValue({ ok: true, messageId: 77 })
    const r = await createIngest(enc('Name,Email\nA,a@x.com\nB,b@x.com\n'), 'apify-abc.csv', { source: 'apify' })

    const [path, bytes] = storage.uploadCsv.mock.calls[0]
    expect(path).toMatch(/^lume\/[0-9a-f-]{36}\.csv$/)
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(svc.insertIngest).toHaveBeenCalledWith({
      sender_platform: 'lume',
      telegram_chat_id: '4242',
      sender_chat_id: '4242',
      sender_name: 'Lume',
      filename: 'apify-abc.csv',
      storage_path: path,
      row_count: 2,
      detected_email_column: 'Email',
      status: 'awaiting_approval',
    })
    const [text, opts] = sendMessage.mock.calls[0]
    expect(text).toBe('📥 New CSV from Lume\nFile: apify-abc.csv\nRows: 2\nEmail column: Email')
    expect(opts.replyMarkup.inline_keyboard[0].map((b: { callback_data: string }) => b.callback_data)).toEqual([
      `approve:${ID}`,
      `approve_enrich:${ID}`,
      `deny:${ID}`,
    ])
    expect(svc.setIngestMessageId).toHaveBeenCalledWith(ID, 77)
    expect(r).toMatchObject({ rowCount: 2, detectedColumn: 'Email', telegram: 'sent', ingest: { telegram_message_id: 77 } })
  })

  it('no detectable column → Deny only', async () => {
    sendMessage.mockResolvedValue({ ok: true, messageId: 1 })
    await createIngest(enc('Email,Work Email\n1,2\n'), 'f.csv', { source: 'csv' })
    expect(svc.insertIngest.mock.calls[0][0].detected_email_column).toBeNull()
    expect(sendMessage.mock.calls[0][1].replyMarkup.inline_keyboard).toEqual([[{ text: '❌ Deny', callback_data: `deny:${ID}` }]])
  })

  it('Telegram unconfigured: the ingest row still exists, no message id', async () => {
    sendMessage.mockResolvedValue({ ok: false, skipped: true })
    const r = await createIngest(enc('email\na@x.com\n'), 'f.csv', { source: 'csv' })
    expect(svc.insertIngest).toHaveBeenCalledTimes(1)
    expect(svc.setIngestMessageId).not.toHaveBeenCalled()
    expect(r.telegram).toBe('skipped')
  })

  it('without TELEGRAM_CHAT_ID the NOT NULL chat columns get a marker', async () => {
    delete process.env.TELEGRAM_CHAT_ID
    sendMessage.mockResolvedValue({ ok: false, skipped: true })
    await createIngest(enc('email\na@x.com\n'), 'f.csv', { source: 'csv' })
    expect(svc.insertIngest.mock.calls[0][0]).toMatchObject({ telegram_chat_id: 'lume', sender_chat_id: 'lume' })
  })

  it('insert failure removes the uploaded object and rethrows; no prompt', async () => {
    svc.insertIngest.mockRejectedValue(new Error('db down'))
    await expect(createIngest(enc('email\na\n'), 'f.csv', { source: 'csv' })).rejects.toThrow('db down')
    expect(storage.removeObject).toHaveBeenCalledWith(storage.uploadCsv.mock.calls[0][0])
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('upload failure → nothing inserted', async () => {
    storage.uploadCsv.mockRejectedValue(new Error('storage 500'))
    await expect(createIngest(enc('email\na\n'), 'f.csv', { source: 'csv' })).rejects.toThrow('storage 500')
    expect(svc.insertIngest).not.toHaveBeenCalled()
  })
})

describe('createApolloOrder', () => {
  it('inserts awaiting_count, sends the count prompt with the lfo keyboard, stores the message id', async () => {
    sendMessage.mockResolvedValue({ ok: true, messageId: 9 })
    const url = 'https://app.apollo.io/#/people?x=1'
    const r = await createApolloOrder(url)
    expect(svc.insertApolloOrder).toHaveBeenCalledWith(url)
    const [text, opts] = sendMessage.mock.calls[0]
    expect(text.startsWith('🔗 Apollo search received.\n')).toBe(true)
    expect(opts.disablePreview).toBe(true)
    expect(opts.replyMarkup.inline_keyboard[1].map((b: { callback_data: string }) => b.callback_data)).toEqual([
      `lfo_custom:${ID}`,
      `lfo_cancel:${ID}`,
    ])
    expect(svc.setApolloOrderMessageId).toHaveBeenCalledWith(ID, 9)
    expect(r.telegram).toBe('sent')
  })
})
