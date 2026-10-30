import { beforeEach, describe, expect, it, vi } from 'vitest'
import ExcelJS from 'exceljs'
import { zipSync, strToU8 } from 'fflate'

/** POST /api/agent/files/sign, POST /api/agent/files (finalize) and GET /api/agent/files/<id>/rows, Storage + DB mocked. */

const h = vi.hoisted(() => ({
  requireOwner: vi.fn(),
  signFileUpload: vi.fn(),
  downloadFileObject: vi.fn(),
  removeFileObjects: vi.fn(),
  storeParsed: vi.fn(),
  loadParsed: vi.fn(),
  insertChatFile: vi.fn(),
  getChatFile: vi.fn(),
  fileInConversation: vi.fn(),
  recordFileUpload: vi.fn(),
  claimFileUpload: vi.fn(),
  clearFileUploads: vi.fn(),
}))
vi.mock('@/lib/auth/guards', () => ({ requireOwner: h.requireOwner }))
vi.mock('@/lib/agent/chatFiles', async () => {
  const real = await vi.importActual<typeof import('@/lib/agent/chatFiles')>('@/lib/agent/chatFiles')
  return { ...real, signFileUpload: h.signFileUpload, downloadFileObject: h.downloadFileObject, removeFileObjects: h.removeFileObjects, storeParsed: h.storeParsed, loadParsed: h.loadParsed, insertChatFile: h.insertChatFile, getChatFile: h.getChatFile, fileInConversation: h.fileInConversation, recordFileUpload: h.recordFileUpload, claimFileUpload: h.claimFileUpload, clearFileUploads: h.clearFileUploads }
})
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => { throw new Error('no db in tests') } }))

process.env.LUME_INTERNAL_SECRET = 'test-secret'

import { POST as SIGN } from '@/app/api/agent/files/sign/route'
import { POST as FINALIZE } from '@/app/api/agent/files/route'
import { GET as ROWS } from '@/app/api/agent/files/[id]/rows/route'
import { fileUploadTicket } from '@/lib/agent/fileTicket'
import { buildSheet, MAX_SHEET_FILE_BYTES } from '@/lib/sheets/model'

const ID = '0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c'
const CONV = '1a2b3c4d-1111-4222-8333-444455556666'

const json = (url: string, body: unknown) => new Request(`https://lume.test${url}`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
const finalize = (path: string, filename = 'leads.xlsx', ticket = fileUploadTicket(path)) => FINALIZE(json('/api/agent/files', { storage_path: path, filename, upload_ticket: ticket }))

async function book(): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook()
  const s = wb.addWorksheet('Leads')
  s.addRow(['Name', 'Email'])
  s.addRow(['Ann', 'ann@acme.com'])
  return new Uint8Array(await wb.xlsx.writeBuffer())
}

beforeEach(() => {
  vi.clearAllMocks()
  h.requireOwner.mockResolvedValue({ ok: true, via: 'session', user: {} })
  h.signFileUpload.mockResolvedValue({ token: 'tok', signedUrl: 'https://s/x' })
  h.getChatFile.mockResolvedValue(null)
  h.storeParsed.mockResolvedValue(undefined)
  h.insertChatFile.mockImplementation(async (row) => ({ ...row, created_at: 'now' }))
  h.removeFileObjects.mockResolvedValue(true)
  h.recordFileUpload.mockResolvedValue(undefined)
  h.claimFileUpload.mockResolvedValue('claimed')
  h.clearFileUploads.mockResolvedValue(undefined)
})

describe('POST /api/agent/files/sign', () => {
  it('signs <uuid>.xlsx / <uuid>.csv with a ticket', async () => {
    for (const [name, ext] of [['Leads Q3.XLSX', 'xlsx'], ['export.csv', 'csv']]) {
      const res = await SIGN(json('/api/agent/files/sign', { filename: name, size: 1000 }))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.path).toMatch(new RegExp(`^[0-9a-f-]{36}\\.${ext}$`))
      expect(body.token).toBe('tok')
      expect(body.upload_ticket).toMatch(/^\d+\.[0-9a-f]{64}$/)
      // Recorded before the object can exist, so the sweep can find it.
      expect(h.recordFileUpload).toHaveBeenCalledWith(body.path)
    }
  })
  it('refuses .xls (save as .xlsx), other types, and files over 10 MB', async () => {
    expect((await (await SIGN(json('/api/agent/files/sign', { filename: 'old.xls', size: 10 }))).json()).error).toBe('xls')
    expect((await SIGN(json('/api/agent/files/sign', { filename: 'a.pdf', size: 10 }))).status).toBe(415)
    expect((await SIGN(json('/api/agent/files/sign', { filename: 'a.xlsx', size: MAX_SHEET_FILE_BYTES + 1 }))).status).toBe(413)
    expect(h.signFileUpload).not.toHaveBeenCalled()
  })
  it('is owner-only', async () => {
    h.requireOwner.mockResolvedValue({ ok: false, response: new Response('{}', { status: 401 }) })
    expect((await SIGN(json('/api/agent/files/sign', { filename: 'a.csv', size: 1 }))).status).toBe(401)
  })
})

describe('POST /api/agent/files (finalize)', () => {
  it('parses a real workbook, stores the parsed tables and returns the file ref', async () => {
    h.downloadFileObject.mockResolvedValue(await book())
    const res = await finalize(`${ID}.xlsx`, 'C:\\Users\\me\\Leads.xlsx')
    expect(res.status).toBe(201)
    const { file } = await res.json()
    expect(file).toEqual({ kind: 'file', id: ID, name: 'Leads.xlsx', file_kind: 'xlsx', size_bytes: expect.any(Number), sheets: [{ name: 'Leads', rows: 1, cols: 2 }] })
    expect(h.storeParsed).toHaveBeenCalledWith(ID, expect.objectContaining({ kind: 'xlsx' }))
    const row = h.insertChatFile.mock.calls[0][0]
    expect(row).toMatchObject({ id: ID, storage_path: `${ID}.xlsx`, parsed_path: `${ID}.json.gz`, kind: 'xlsx' })
    expect(row.summary).toContain('Name,Email\nAnn,ann@acme.com')
    expect(row.brief).toContain('Header of "Leads": Name,Email')
    expect(row.brief).not.toContain('ann@acme.com')
    expect(h.removeFileObjects).not.toHaveBeenCalled()
    expect(h.claimFileUpload).toHaveBeenCalledWith(`${ID}.xlsx`)
    expect(h.clearFileUploads).toHaveBeenCalledWith([`${ID}.xlsx`])
  })

  it('takes the type from the magic bytes: a CSV renamed .xlsx is read as CSV', async () => {
    h.downloadFileObject.mockResolvedValue(strToU8('Name;Email\nAnn;a@x.com\n'))
    const res = await finalize(`${ID}.xlsx`)
    expect(res.status).toBe(201)
    expect((await res.json()).file.file_kind).toBe('csv')
  })

  it('refuses binary, OLE (.xls / encrypted), and a zip that is not a workbook, and deletes the upload', async () => {
    const cases: [Uint8Array, string, number][] = [
      [strToU8('%PDF-1.7 ...'), 'unsupported_media_type', 415],
      [new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]), 'legacy_or_encrypted', 415],
      [zipSync({ 'a.txt': strToU8('x') }), 'not_xlsx', 415],
    ]
    for (const [bytes, error, status] of cases) {
      h.downloadFileObject.mockResolvedValueOnce(bytes)
      const res = await finalize(`${ID}.xlsx`)
      expect(res.status).toBe(status)
      expect((await res.json()).error).toBe(error)
    }
    expect(h.removeFileObjects).toHaveBeenCalledTimes(3)
    expect(h.removeFileObjects).toHaveBeenCalledWith([`${ID}.xlsx`, `${ID}.json.gz`])
    expect(h.clearFileUploads).toHaveBeenCalledTimes(3)
    expect(h.insertChatFile).not.toHaveBeenCalled()
  })

  it('refuses a zip bomb (uncompressed cap) with 422 and deletes it', async () => {
    const bomb = zipSync({ 'xl/workbook.xml': strToU8('<sheets><sheet name="a"/></sheets>'), 'xl/worksheets/sheet1.xml': new Uint8Array(60 * 1024 * 1024) }, { level: 9 })
    h.downloadFileObject.mockResolvedValue(bomb)
    const res = await finalize(`${ID}.xlsx`)
    expect(res.status).toBe(422)
    expect((await res.json()).error).toBe('too_large_uncompressed')
    expect(h.removeFileObjects).toHaveBeenCalled()
  })

  it('checks the path, then the ticket, before touching Storage', async () => {
    expect((await finalize('../x.xlsx')).status).toBe(400)
    expect((await finalize(`${ID}.xlsx`, 'a.xlsx', '1.' + '0'.repeat(64))).status).toBe(403)
    expect((await finalize(`${ID}.xlsx`, 'a.xlsx', fileUploadTicket(`${ID}.csv`))).status).toBe(403)
    expect(h.downloadFileObject).not.toHaveBeenCalled()
  })

  it('a concurrent second finalize loses the claim: 409, and it never deletes the first one\'s objects', async () => {
    let release!: (b: Uint8Array) => void
    h.downloadFileObject.mockReturnValueOnce(new Promise<Uint8Array>((r) => (release = r)))
    h.claimFileUpload.mockResolvedValueOnce('claimed').mockResolvedValueOnce('taken')
    const first = finalize(`${ID}.xlsx`)
    const second = await finalize(`${ID}.xlsx`)
    expect(second.status).toBe(409)
    expect((await second.json()).error).toBe('already_added')
    expect(h.removeFileObjects).not.toHaveBeenCalled()
    release(await book())
    expect((await first).status).toBe(201)
    expect(h.removeFileObjects).not.toHaveBeenCalled()
    expect(h.insertChatFile).toHaveBeenCalledTimes(1)
  })

  it('an upload already finalized (claim gone, row there) is 409; never signed or swept is 404; neither cleans up', async () => {
    h.claimFileUpload.mockResolvedValue('missing')
    h.getChatFile.mockResolvedValueOnce({ id: ID })
    expect((await finalize(`${ID}.csv`)).status).toBe(409)
    expect((await finalize(`${ID}.csv`)).status).toBe(404)
    expect(h.removeFileObjects).not.toHaveBeenCalled()
    expect(h.downloadFileObject).not.toHaveBeenCalled()
  })

  it('the claim holder cleans up: object gone (404) or over 10 MB (413)', async () => {
    h.downloadFileObject.mockResolvedValueOnce(null)
    expect((await finalize(`${ID}.csv`)).status).toBe(404)
    h.downloadFileObject.mockResolvedValueOnce('too_large')
    expect((await finalize(`${ID}.csv`)).status).toBe(413)
    expect(h.removeFileObjects).toHaveBeenCalledTimes(2)
    expect(h.clearFileUploads).toHaveBeenCalledTimes(2)
  })

  it('parsed tables too big for the bucket even gzipped: 422, cleaned up', async () => {
    const { ParsedTooLargeError } = await vi.importActual<typeof import('@/lib/agent/chatFiles')>('@/lib/agent/chatFiles')
    h.downloadFileObject.mockResolvedValue(await book())
    h.storeParsed.mockRejectedValueOnce(new ParsedTooLargeError())
    const res = await finalize(`${ID}.xlsx`)
    expect(res.status).toBe(422)
    expect((await res.json()).error).toBe('too_large_uncompressed')
    expect(h.removeFileObjects).toHaveBeenCalledWith([`${ID}.xlsx`, `${ID}.json.gz`])
    expect(h.insertChatFile).not.toHaveBeenCalled()
  })
})

describe('GET /api/agent/files/<id>/rows', () => {
  const sheet = buildSheet('Leads', false, [['Name', 'Email'], ...Array.from({ length: 30 }, (_, i) => [`P${i}`, `p${i}@x.com`])])
  beforeEach(() => {
    h.getChatFile.mockResolvedValue({ id: ID, name: 'leads.xlsx' })
    h.loadParsed.mockResolvedValue({ kind: 'xlsx', sheets: [sheet] })
    h.fileInConversation.mockResolvedValue(true)
  })
  const get = (qs: string) => ROWS(new Request(`https://lume.test/api/agent/files/${ID}/rows?${qs}`), { params: Promise.resolve({ id: ID }) })

  it('pages a sheet as CSV', async () => {
    const res = await get(`sheet=Leads&offset=10&limit=5&conversation=${CONV}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ file_id: ID, sheet: 'Leads', sheets: ['Leads'], offset: 10, returned: 5, total_rows: 30, next_offset: 15 })
    expect(body.csv.split('\n')).toEqual(['Name,Email', 'P10,p10@x.com', 'P11,p11@x.com', 'P12,p12@x.com', 'P13,p13@x.com', 'P14,p14@x.com'])
    expect(h.fileInConversation).toHaveBeenCalledWith(ID, CONV)
  })
  it('404 when the file is not attached in this conversation, or the sheet is unknown (names listed)', async () => {
    h.fileInConversation.mockResolvedValueOnce(false)
    expect((await get(`conversation=${CONV}`)).status).toBe(404)
    const res = await get('sheet=Nope')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'sheet_not_found', sheets: ['Leads'] })
  })
  it('400 on a bad range', async () => {
    expect((await get('limit=501')).status).toBe(400)
    expect((await get('offset=-1')).status).toBe(400)
  })
})
