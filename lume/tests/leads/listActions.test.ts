import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({ getList: vi.fn(), emailCsv: vi.fn(), markSent: vi.fn(), deleteList: vi.fn() }))
const ingest = vi.hoisted(() => ({ createIngest: vi.fn() }))
vi.mock('@/lib/leads/lists/store', () => store)
vi.mock('@/lib/import/ingest', () => ingest)

import { buildDeleteLeadList, buildSendLeadList, executeDeleteLeadList, executeSendLeadList, sendLeadListNow } from '@/lib/leads/lists/actions'
import { leadListPayloadError } from '@/lib/leads/lists/actionPayload'

const LIST = '11111111-1111-4111-8111-111111111111'
const INGEST = '22222222-2222-4222-8222-222222222222'
const list = (o: Record<string, unknown> = {}) => ({ id: LIST, name: 'PM owners', item_count: 120, email_count: 80, updated_at: '2026-11-06T01:00:00Z', sent_at: null, ...o })

beforeEach(() => {
  vi.clearAllMocks()
  store.getList.mockResolvedValue(list())
  store.emailCsv.mockResolvedValue({ csv: 'Name,Email\nA,a@a.co\n', rows: 80 })
  store.markSent.mockResolvedValue(undefined)
  ingest.createIngest.mockResolvedValue({ ingest: { id: INGEST }, rowCount: 80, detectedColumn: 'Email', telegram: 'sent' })
})

describe('send_lead_list', () => {
  it('build: names the list, how many rows carry an email, and that nothing is spent before the ingest gate', async () => {
    const b = await buildSendLeadList({ list_id: LIST })
    expect(b.ok).toBe(true)
    if (!b.ok) return
    expect(b.kind).toBe('send_lead_list')
    expect(b.payload).toMatchObject({ list_id: LIST, name: 'PM owners', rows: 120, email_rows: 80, list_updated_at: '2026-11-06T01:00:00Z' })
    expect(b.payload.summary).toContain('80 of 120 rows have an email')
    expect(b.payload.summary).toContain('nothing is validated or spent until that gate is approved')
    expect(leadListPayloadError(b.payload)).toBeNull()
  })

  it('build: refuses a list with no emails (and says how many rows it has), a missing list, and one already sent unchanged', async () => {
    store.getList.mockResolvedValueOnce(list({ email_count: 0 }))
    expect(await buildSendLeadList({ list_id: LIST })).toEqual({ ok: false, status: 422, error: 'no_emails: 0 of 120 rows have an email' })
    store.getList.mockResolvedValueOnce(null)
    expect(await buildSendLeadList({ list_id: LIST })).toMatchObject({ ok: false, status: 404 })
    store.getList.mockResolvedValueOnce(list({ sent_at: '2026-11-06T02:00:00Z' }))
    expect(await buildSendLeadList({ list_id: LIST })).toMatchObject({ ok: false, status: 409, error: 'already_sent' })
    expect(await buildSendLeadList({ list_id: 'nope' })).toMatchObject({ ok: false, status: 400 })
  })

  it('execute: re-checks the list is as approved, writes the email rows as a CSV ingest (the usual gate) and records it on the list', async () => {
    const b = await buildSendLeadList({ list_id: LIST })
    if (!b.ok) throw new Error('build')
    const r = await executeSendLeadList(b.payload)
    expect(r).toMatchObject({ ok: true, result: { ingest_id: INGEST, rows: 80, gate: `ingest_approval:${INGEST}` } })
    const [bytes, filename, meta] = ingest.createIngest.mock.calls[0]
    expect(new TextDecoder().decode(bytes)).toBe('Name,Email\nA,a@a.co\n')
    expect(filename).toBe('PM owners.csv')
    expect(meta).toMatchObject({ source: 'csv' })
    expect(store.markSent).toHaveBeenCalledWith(LIST, INGEST, 80)
  })

  it('execute: a list changed since approval is refused, nothing ingested', async () => {
    const b = await buildSendLeadList({ list_id: LIST })
    if (!b.ok) throw new Error('build')
    store.getList.mockResolvedValueOnce(list({ email_count: 81, updated_at: '2026-11-06T03:00:00Z' }))
    const r = await executeSendLeadList(b.payload)
    expect(r.ok).toBe(false)
    expect(ingest.createIngest).not.toHaveBeenCalled()
  })

  it("the page's direct send: same refusals, same ingest", async () => {
    store.getList.mockResolvedValueOnce(list({ email_count: 0 }))
    expect(await sendLeadListNow(LIST)).toMatchObject({ ok: false, status: 422 })
    expect(await sendLeadListNow(LIST)).toMatchObject({ ok: true, result: { ingest_id: INGEST } })
  })
})

describe('delete_lead_list', () => {
  it('build names the list and its size; execute deletes it', async () => {
    const b = await buildDeleteLeadList({ list_id: LIST })
    expect(b).toMatchObject({ ok: true, kind: 'delete_lead_list', payload: { list_id: LIST, name: 'PM owners', rows: 120 } })
    store.deleteList.mockResolvedValue(true)
    expect(await executeDeleteLeadList({ list_id: LIST })).toMatchObject({ ok: true, result: { deleted: true } })
    store.deleteList.mockResolvedValue(false)
    expect((await executeDeleteLeadList({ list_id: LIST })).ok).toBe(false)
  })
})
