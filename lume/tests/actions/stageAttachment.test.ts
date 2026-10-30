import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildSheet } from '@/lib/sheets/model'

/** stage_attachment: build snapshot, executor re-checks, and the Import CSV path it ends in. */

const h = vi.hoisted(() => ({ getChatFile: vi.fn(), loadParsed: vi.fn(), createIngest: vi.fn(), findIngestByStoragePath: vi.fn(), fileInConversation: vi.fn() }))
vi.mock('@/lib/agent/chatFiles', () => ({ getChatFile: h.getChatFile, loadParsed: h.loadParsed }))
vi.mock('@/lib/import/ingest', () => ({ createIngest: h.createIngest }))
vi.mock('@/lib/db/service', () => ({ findIngestByStoragePath: h.findIngestByStoragePath }))

import { buildStageAttachment, executeStageAttachment } from '@/lib/agent/attachmentAction'
import { attachmentKey, stageAttachmentPayloadError } from '@/lib/agent/attachmentActionPayload'
import { ingestFilename } from '@/lib/agent/attachmentIngest'

const FILE = '0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c'
const leads = buildSheet('Leads', false, [['Name', 'Work Email', 'Note'], ['Ann', 'ann@acme.com', 'two\nlines'], ['Bo', 'bo@b.co', '']])
const noEmail = buildSheet('Other', false, [['Name', 'Phone'], ['Ann', '1']])

beforeEach(() => {
  vi.resetAllMocks()
  h.getChatFile.mockResolvedValue({ id: FILE, name: 'Q3 leads.xlsx', kind: 'xlsx' })
  h.loadParsed.mockResolvedValue({ kind: 'xlsx', sheets: [leads, noEmail] })
  h.createIngest.mockResolvedValue({ ingest: { id: 'ing1' }, rowCount: 2, detectedColumn: 'Work Email', telegram: 'sent' })
  h.findIngestByStoragePath.mockResolvedValue(null)
})

describe('buildStageAttachment', () => {
  it('snapshots the sheet: rows, the email column telegram-inbox will use, a key per file + sheet', async () => {
    const b = await buildStageAttachment({ file_id: FILE.toUpperCase(), sheet: 'leads' })
    if (!b.ok) throw new Error(b.error)
    expect(b.kind).toBe('stage_attachment')
    expect(b.payload).toMatchObject({ file_id: FILE, file_name: 'Q3 leads.xlsx', sheet: 'Leads', rows: 2, email_column: 'Work Email', filename: 'Q3 leads - Leads.csv', attachment_key: `${FILE}:Leads` })
    expect(b.payload.summary).toMatch(/Stage 2 rows from Q3 leads\.xlsx · "Leads" for validation \(email column "Work Email"\)/)
    expect(b.payload.summary).toMatch(/Approve \/ Deny ingest gate/)
    expect(stageAttachmentPayloadError(b.payload)).toBeNull()
  })
  it('refuses a sheet without an email column, a missing file or sheet', async () => {
    expect(await buildStageAttachment({ file_id: FILE, sheet: 'Other' })).toMatchObject({ ok: false, status: 422, error: expect.stringMatching(/^no_email_column/) })
    expect(await buildStageAttachment({ file_id: FILE, sheet: 'Nope' })).toEqual({ ok: false, status: 404, error: 'sheet_not_found' })
    h.getChatFile.mockResolvedValue(null)
    expect(await buildStageAttachment({ file_id: FILE })).toEqual({ ok: false, status: 404, error: 'file_not_found' })
    expect(await buildStageAttachment({ file_id: 'nope' })).toEqual({ ok: false, status: 400, error: 'invalid_payload' })
  })
})

describe('executeStageAttachment', () => {
  const approved = { file_id: FILE, sheet: 'Leads', rows: 2, email_column: 'Work Email', attachment_key: attachmentKey(FILE, 'Leads'), summary: 's' }

  it('re-checks, then hands the sheet as CSV to the Import CSV intake (ingest gate); never a validation job', async () => {
    const out = await executeStageAttachment(approved)
    expect(out).toEqual({ ok: true, result: expect.objectContaining({ ingest_id: 'ing1', row_count: 2, gate: 'ingest_approval:ing1', telegram: 'sent' }) })
    const [bytes, filename, meta] = h.createIngest.mock.calls[0]
    expect(new TextDecoder().decode(bytes)).toBe('Name,Work Email,Note\nAnn,ann@acme.com,two lines\nBo,bo@b.co,\n')
    expect(filename).toBe('Q3 leads - Leads.csv')
    expect(meta).toMatchObject({ source: 'csv', detail: 'chat attachment Q3 leads.xlsx · Leads', storagePath: expect.stringMatching(/^lume\/[0-9a-f-]{36}\.csv$/) })
  })
  it('the same sheet already sent (by Import or an earlier staging) is refused at build and at execute', async () => {
    h.findIngestByStoragePath.mockResolvedValue({ id: 'ing0' })
    expect(await buildStageAttachment({ file_id: FILE, sheet: 'Leads' })).toEqual({ ok: false, status: 409, error: 'already_ingested' })
    expect(await executeStageAttachment(approved)).toMatchObject({ ok: false, error: 're-check failed: already_ingested' })
    expect(h.createIngest).not.toHaveBeenCalled()
  })
  it('fails without ingesting when the file is gone, the sheet moved, or rows / email column changed', async () => {
    h.getChatFile.mockResolvedValueOnce(null)
    expect(await executeStageAttachment(approved)).toMatchObject({ ok: false, error: 're-check failed: file_not_found' })
    expect(await executeStageAttachment({ ...approved, rows: 3 })).toMatchObject({ ok: false, error: /no longer matches/ })
    expect(await executeStageAttachment({ ...approved, email_column: 'Email' })).toMatchObject({ ok: false })
    expect(await executeStageAttachment({ ...approved, sheet: '1' })).toMatchObject({ ok: false, error: 're-check failed: sheet_not_found' })
    expect(h.createIngest).not.toHaveBeenCalled()
  })
})

describe('payload check and names', () => {
  it('createAction refuses a payload the executor could not re-check', () => {
    expect(stageAttachmentPayloadError({ file_id: FILE, sheet: 'L', rows: 1, attachment_key: `${FILE}:L` })).toBeNull()
    expect(stageAttachmentPayloadError({ file_id: FILE.toUpperCase(), sheet: 'L', rows: 1, attachment_key: 'x' })).toMatch(/file_id/)
    expect(stageAttachmentPayloadError({ file_id: FILE, sheet: 'L', rows: 0, attachment_key: `${FILE}:L` })).toMatch(/rows/)
    expect(stageAttachmentPayloadError({ file_id: FILE, sheet: 'L', rows: 1, attachment_key: 'other' })).toMatch(/attachment_key/)
  })
  it('ingest file names', () => {
    expect(ingestFilename('export.csv', 'csv', 'Sheet1')).toBe('export.csv')
    expect(ingestFilename('a/b.xlsx', 'xlsx', 'Q3')).toBe('a b - Q3.csv')
  })
})
