import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildSheet } from '@/lib/sheets/model'

/** POST /api/import/xlsx: a parsed workbook's chosen sheet → the CSV intake (ingest gate). */

const h = vi.hoisted(() => ({ requireOwner: vi.fn(), getChatFile: vi.fn(), loadParsed: vi.fn(), createIngest: vi.fn(), findIngestByStoragePath: vi.fn() }))
vi.mock('@/lib/auth/guards', () => ({ requireOwner: h.requireOwner }))
vi.mock('@/lib/agent/chatFiles', () => ({ getChatFile: h.getChatFile, loadParsed: h.loadParsed }))
vi.mock('@/lib/import/ingest', () => ({ createIngest: h.createIngest }))
vi.mock('@/lib/db/service', () => ({ isDbError: () => false, findIngestByStoragePath: h.findIngestByStoragePath }))

import { POST } from '@/app/api/import/xlsx/route'

const FILE = '0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c'
const post = (body: unknown) => POST(new Request('https://lume.test/api/import/xlsx', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }))

beforeEach(() => {
  vi.resetAllMocks()
  h.requireOwner.mockResolvedValue({ ok: true, via: 'session' })
  h.getChatFile.mockResolvedValue({ id: FILE, name: 'book.xlsx', kind: 'xlsx' })
  h.loadParsed.mockResolvedValue({
    kind: 'xlsx',
    sheets: [buildSheet('Summary', false, [['Total'], ['3']]), buildSheet('Leads', false, [['Email', 'Name'], ['a@x.com', 'A'], ['b@y.com', 'B']])],
  })
  h.createIngest.mockResolvedValue({ ingest: { id: 'ing1' }, rowCount: 2, detectedColumn: 'Email', telegram: 'skipped' })
  h.findIngestByStoragePath.mockResolvedValue(null)
})

describe('POST /api/import/xlsx', () => {
  it('ingests the chosen sheet as CSV and answers like the CSV import', async () => {
    const res = await post({ file_id: FILE, sheet: 'Leads' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, ingest_id: 'ing1', row_count: 2, email_column: 'Email', telegram: 'skipped', gate: 'ingest_approval:ing1' })
    const [bytes, filename, meta] = h.createIngest.mock.calls[0]
    expect(new TextDecoder().decode(bytes)).toBe('Email,Name\na@x.com,A\nb@y.com,B\n')
    expect(filename).toBe('book - Leads.csv')
    expect(meta.source).toBe('csv')
    // One ingest path per file + sheet, so a second import of the same sheet is caught.
    expect(meta.storagePath).toMatch(/^lume\/[0-9a-f-]{36}\.csv$/)
  })

  it('409 already_ingested for a sheet already sent (here or by the agent), before anything is written', async () => {
    await post({ file_id: FILE, sheet: 'Leads' })
    const path = h.createIngest.mock.calls[0][2].storagePath
    h.findIngestByStoragePath.mockImplementation(async (p: string) => (p === path ? { id: 'ing1' } : null))
    const res = await post({ file_id: FILE, sheet: 'Leads' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('already_ingested')
    expect(h.createIngest).toHaveBeenCalledTimes(1)
    // Another sheet of the same file is a different ingest.
    expect((await post({ file_id: FILE, sheet: 'Summary' })).status).toBe(200)
    expect(h.createIngest.mock.calls[1][2].storagePath).not.toBe(path)
  })

  it('a concurrent import that loses the exclusive upload is 409 already_ingested too', async () => {
    const { StorageError } = await vi.importActual<typeof import('@/lib/import/storage')>('@/lib/import/storage')
    h.createIngest.mockRejectedValue(new StorageError('upload', 400, '{"statusCode":"409","error":"Duplicate","message":"The resource already exists"}'))
    const res = await post({ file_id: FILE, sheet: 'Leads' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('already_ingested')
  })
  it('needs the exact sheet name (lists the sheets) and the file', async () => {
    const res = await post({ file_id: FILE, sheet: 'leads' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'sheet_not_found', sheets: ['Summary', 'Leads'] })
    h.getChatFile.mockResolvedValue(null)
    expect((await post({ file_id: FILE, sheet: 'Leads' })).status).toBe(404)
    expect((await post({ file_id: 'x', sheet: 'Leads' })).status).toBe(400)
    expect(h.createIngest).not.toHaveBeenCalled()
  })
})
