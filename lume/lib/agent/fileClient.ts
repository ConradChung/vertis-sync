/**
 * Browser side of chat spreadsheets: sign → upload straight to Storage →
 * finalize (the server sniffs and parses). Never throws. The file never
 * passes through a function body, so 10 MB fits under Vercel's ~4.5 MB cap.
 */
import { createClient } from '@/lib/supabase/client'
import { FILE_BUCKET, type ChatFileRef } from '@/lib/agent/files'
import { MAX_SHEET_FILE_BYTES, SHEET_MIME, sheetExt } from '@/lib/sheets/model'

export type FileUploadError =
  | 'xls'
  | 'unsupported_media_type'
  | 'too_large'
  | 'legacy_or_encrypted'
  | 'too_large_uncompressed'
  | 'too_many_sheets'
  | 'too_many_cells'
  | 'too_many_columns'
  | 'not_xlsx'
  | 'not_csv'
  | 'empty'
  | 'unreadable'
  | 'invalid_ticket'
  | 'upload_missing'
  | 'upload'

const KNOWN: readonly string[] = [
  'xls', 'unsupported_media_type', 'too_large', 'legacy_or_encrypted', 'too_large_uncompressed', 'too_many_sheets', 'too_many_cells', 'too_many_columns',
  'not_xlsx', 'not_csv', 'empty', 'unreadable', 'invalid_ticket', 'upload_missing',
]

export type FileUpload = { ok: true; ref: ChatFileRef } | { ok: false; error: FileUploadError }

export interface FileUploadDeps {
  post: (url: string, body: unknown) => Promise<{ status: number; body: Record<string, unknown> }>
  upload: (path: string, token: string, bytes: ArrayBuffer, contentType: string) => Promise<{ error: unknown }>
}

const realDeps: FileUploadDeps = {
  post: async (url, body) => {
    const res = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { status: res.status, body: ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown> }
  },
  upload: async (path, token, bytes, contentType) => {
    // A raw body (ArrayBuffer) is sent with Content-Type: contentType; a Blob would carry the browser's
    // own type (vnd.ms-excel for a Windows .csv), which the bucket's MIME allowlist refuses.
    const { error } = await createClient().storage.from(FILE_BUCKET).uploadToSignedUrl(path, token, bytes, { contentType })
    return { error }
  },
}

const code = (b: Record<string, unknown>): FileUploadError => (typeof b.error === 'string' && KNOWN.includes(b.error) ? (b.error as FileUploadError) : 'upload')

export async function uploadChatFile(file: File, deps: FileUploadDeps = realDeps): Promise<FileUpload> {
  const ext = sheetExt(file.name) ?? (file.type === 'text/csv' ? 'csv' : null)
  if (ext === 'xls') return { ok: false, error: 'xls' }
  if (!ext) return { ok: false, error: 'unsupported_media_type' }
  if (file.size > MAX_SHEET_FILE_BYTES) return { ok: false, error: 'too_large' }
  if (!file.size) return { ok: false, error: 'empty' }
  const filename = sheetExt(file.name) ? file.name : `${file.name || 'spreadsheet'}.${ext}`
  try {
    const sign = await deps.post('/api/agent/files/sign', { filename, size: file.size })
    if (sign.status !== 200) return { ok: false, error: code(sign.body) }
    const { path, token, upload_ticket } = sign.body as { path: string; token: string; upload_ticket: string }
    const up = await deps.upload(path, token, await file.arrayBuffer(), SHEET_MIME[ext])
    if (up.error) return { ok: false, error: 'upload' }
    const done = await deps.post('/api/agent/files', { storage_path: path, filename, upload_ticket })
    const ref = (done.body as { file?: ChatFileRef }).file
    if (done.status === 201 && ref) return { ok: true, ref }
    return { ok: false, error: code(done.body) }
  } catch {
    return { ok: false, error: 'upload' }
  }
}
