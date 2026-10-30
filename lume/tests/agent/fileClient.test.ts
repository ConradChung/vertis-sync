import { describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/supabase/client', () => ({ createClient: () => { throw new Error('not in tests') } }))
import { uploadChatFile, type FileUploadDeps } from '@/lib/agent/fileClient'
import { MAX_SHEET_FILE_BYTES } from '@/lib/sheets/model'

const REF = { kind: 'file', id: 'x', name: 'a.csv', file_kind: 'csv', size_bytes: 3, sheets: [] }

function deps(answers: { sign?: [number, object]; done?: [number, object]; uploadError?: unknown } = {}) {
  const post = vi.fn(async (url: string) => {
    const [status, body] = url.endsWith('/sign') ? (answers.sign ?? [200, { path: 'p.csv', token: 't', upload_ticket: 'k' }]) : (answers.done ?? [201, { file: REF }])
    return { status, body: body as Record<string, unknown> }
  })
  const upload = vi.fn(async () => ({ error: answers.uploadError ?? null }))
  return { post, upload } satisfies FileUploadDeps
}

describe('uploadChatFile', () => {
  it('sign → raw upload with the type from the extension → finalize', async () => {
    const d = deps()
    const r = await uploadChatFile(new File(['a,b'], 'a.csv', { type: 'application/vnd.ms-excel' }), d)
    expect(r).toEqual({ ok: true, ref: REF })
    expect(d.post.mock.calls[0]).toEqual(['/api/agent/files/sign', { filename: 'a.csv', size: 3 }])
    expect(d.upload).toHaveBeenCalledWith('p.csv', 't', expect.any(ArrayBuffer), 'text/csv')
    expect(d.post.mock.calls[1]).toEqual(['/api/agent/files', { storage_path: 'p.csv', filename: 'a.csv', upload_ticket: 'k' }])
  })
  it('refuses .xls, other types, oversize and empty files before any request', async () => {
    const d = deps()
    expect(await uploadChatFile(new File(['x'], 'a.xls'), d)).toEqual({ ok: false, error: 'xls' })
    expect(await uploadChatFile(new File(['x'], 'a.pdf'), d)).toEqual({ ok: false, error: 'unsupported_media_type' })
    expect(await uploadChatFile(new File([new Uint8Array(MAX_SHEET_FILE_BYTES + 1)], 'a.xlsx'), d)).toEqual({ ok: false, error: 'too_large' })
    expect(await uploadChatFile(new File([], 'a.csv'), d)).toEqual({ ok: false, error: 'empty' })
    expect(d.post).not.toHaveBeenCalled()
  })
  it('passes the server code through; a Storage failure is upload', async () => {
    expect(await uploadChatFile(new File(['x'], 'a.xlsx'), deps({ done: [415, { error: 'legacy_or_encrypted' }] }))).toEqual({ ok: false, error: 'legacy_or_encrypted' })
    expect(await uploadChatFile(new File(['x'], 'a.xlsx'), deps({ uploadError: { message: 'mime' } }))).toEqual({ ok: false, error: 'upload' })
    expect(await uploadChatFile(new File(['x'], 'a.xlsx'), deps({ done: [500, { error: 'weird' }] }))).toEqual({ ok: false, error: 'upload' })
  })
})
