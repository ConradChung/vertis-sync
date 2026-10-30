import 'server-only'
import { gunzipSync, gzipSync, strFromU8, strToU8 } from 'fflate'
import { createServiceClient } from '@/lib/supabase/service'
import { DbError } from '@/lib/db/service'
import { FILE_BUCKET, FILE_PATH_RE, parsedPathFor, type ChatFileRef } from '@/lib/agent/files'
import { MAX_SHEET_FILE_BYTES, type ParsedWorkbook, type SheetFileKind, type SheetMeta } from '@/lib/sheets/model'

/**
 * The private `agent-chat-files` bucket and the `agent_chat_files` table
 * (service role only; callers check the owner first). Source files live at
 * `<id>.<xlsx|csv>`, their parsed tables at `<id>.json.gz`.
 */

export class ChatFileStorageError extends Error {
  constructor(op: string, detail: string) {
    super(`${FILE_BUCKET} ${op}: ${detail.slice(0, 200)}`)
    this.name = 'ChatFileStorageError'
  }
}

const bucket = () => createServiceClient().storage.from(FILE_BUCKET)

const missing = (error: unknown) => {
  const e = error as { status?: number; statusCode?: string; message?: string } | null
  return e?.status === 400 || e?.status === 404 || e?.statusCode === '404' || /not.?found/i.test(e?.message ?? '')
}

export async function signFileUpload(path: string): Promise<{ token: string; signedUrl: string }> {
  const { data, error } = await bucket().createSignedUploadUrl(path)
  if (error || !data) throw new ChatFileStorageError('sign', error?.message ?? 'no data')
  return { token: data.token, signedUrl: data.signedUrl }
}

/** The object's bytes; null when missing; 'too_large' past the cap. */
export async function downloadFileObject(path: string, maxBytes = MAX_SHEET_FILE_BYTES): Promise<Uint8Array | null | 'too_large'> {
  const { data, error } = await bucket().download(path)
  if (error || !data) {
    if (missing(error)) return null
    throw new ChatFileStorageError('download', (error as { message?: string } | null)?.message ?? 'no data')
  }
  if (data.size > maxBytes) return 'too_large'
  return new Uint8Array(await data.arrayBuffer())
}

/** Best effort: a failed removal is logged, never thrown. true when Storage confirmed it. */
export async function removeFileObjects(paths: string[]): Promise<boolean> {
  if (!paths.length) return true
  try {
    const { error } = await bucket().remove(paths)
    if (!error) return true
    console.error('[agent-chat-files] remove failed:', error.message)
  } catch (err) {
    console.error('[agent-chat-files] remove failed:', err instanceof Error ? err.message : err)
  }
  return false
}

/** The bucket's file_size_limit (migration 20261030101700): the gzipped parsed copy must fit too. */
export const MAX_PARSED_GZ_BYTES = 11_534_336

/** The parsed tables do not fit the bucket even gzipped (refused like a too-big file). */
export class ParsedTooLargeError extends Error {
  constructor() {
    super('parsed_too_large')
    this.name = 'ParsedTooLargeError'
  }
}

export async function storeParsed(id: string, wb: ParsedWorkbook): Promise<void> {
  const gz = gzipSync(strToU8(JSON.stringify({ v: 1, ...wb })), { level: 6 })
  if (gz.byteLength > MAX_PARSED_GZ_BYTES) throw new ParsedTooLargeError()
  const { error } = await bucket().upload(parsedPathFor(id), gz, { contentType: 'application/gzip', upsert: false })
  if (error) throw new ChatFileStorageError('upload', error.message)
}

/** The parsed tables, or null when the object is gone. Throws on a Storage failure. */
export async function loadParsed(id: string): Promise<ParsedWorkbook | null> {
  const { data, error } = await bucket().download(parsedPathFor(id))
  if (error || !data) {
    if (missing(error)) return null
    throw new ChatFileStorageError('download', (error as { message?: string } | null)?.message ?? 'no data')
  }
  const json = JSON.parse(strFromU8(gunzipSync(new Uint8Array(await data.arrayBuffer())))) as ParsedWorkbook & { v?: number }
  return { kind: json.kind, sheets: json.sheets, ...(json.encoding ? { encoding: json.encoding } : {}), ...(json.delimiter ? { delimiter: json.delimiter } : {}) }
}

// ---------------------------------------------------------------------------
// Signed uploads (agent_chat_file_uploads): recorded at sign, claimed once at
// finalize, swept by /api/cron/project-uploads when never finalized.

/** Recorded before the object can exist, so nothing is ever untracked. */
export async function recordFileUpload(path: string): Promise<void> {
  const res = await createServiceClient().from('agent_chat_file_uploads').insert({ storage_path: path })
  if (res.error) throw new DbError('recordFileUpload', res.error)
}

/**
 * The one finalize that may process (and on failure delete) this upload:
 * `claimed_at is null → now()`. 'taken' = another finalize has it (or had it);
 * 'missing' = never signed, already finalized, or swept.
 */
export async function claimFileUpload(path: string): Promise<'claimed' | 'taken' | 'missing'> {
  const sb = createServiceClient()
  const res = await sb.from('agent_chat_file_uploads').update({ claimed_at: new Date().toISOString() }).eq('storage_path', path).is('claimed_at', null).select('storage_path')
  if (res.error) throw new DbError('claimFileUpload', res.error)
  if ((res.data ?? []).length) return 'claimed'
  const row = await sb.from('agent_chat_file_uploads').select('storage_path').eq('storage_path', path).maybeSingle()
  if (row.error) throw new DbError('claimFileUpload.read', row.error)
  return row.data ? 'taken' : 'missing'
}

export async function clearFileUploads(paths: string[]): Promise<void> {
  if (!paths.length) return
  const res = await createServiceClient().from('agent_chat_file_uploads').delete().in('storage_path', paths)
  if (res.error) throw new DbError('clearFileUploads', res.error)
}

export async function staleFileUploads(before: Date, limit = 200): Promise<string[]> {
  const res = await createServiceClient()
    .from('agent_chat_file_uploads')
    .select('storage_path')
    .lt('created_at', before.toISOString())
    .order('created_at')
    .limit(limit)
  if (res.error) throw new DbError('staleFileUploads', res.error)
  return ((res.data ?? []) as { storage_path: string }[]).map((r) => r.storage_path)
}

/**
 * The hourly sweep's share: uploads signed over `before` and never finalized
 * (no agent_chat_files row) lose their source and parsed objects; a finalized
 * one only loses its leftover row. A failed Storage delete keeps the rows
 * for the next run.
 */
export async function sweepFileUploads(before: Date): Promise<{ ok: boolean; removed: number; kept: number }> {
  const stale = await staleFileUploads(before)
  if (!stale.length) return { ok: true, removed: 0, kept: 0 }
  const idOf = (p: string) => FILE_PATH_RE.exec(p)?.[1] ?? null
  const ids = stale.map(idOf).filter((x): x is string => !!x)
  const done = new Set((await getChatFiles(ids)).map((r) => r.id))
  const orphans = stale.filter((p) => !done.has(idOf(p) ?? ''))
  const objects = orphans.flatMap((p) => {
    const id = idOf(p)
    return id ? [p, parsedPathFor(id)] : [p]
  })
  const removed = await removeFileObjects(objects)
  await clearFileUploads(removed ? stale : stale.filter((p) => done.has(idOf(p) ?? '')))
  return { ok: removed, removed: removed ? orphans.length : 0, kept: stale.length - orphans.length }
}

export interface ChatFileRow {
  id: string
  name: string
  kind: SheetFileKind
  size_bytes: number
  storage_path: string
  parsed_path: string
  sheets: SheetMeta[]
  summary: string
  /** The replay form: name, sheets with counts, headers, no rows. */
  brief: string
  /** The chat it was first sent in; null = uploaded, not sent yet. */
  conversation_id: string | null
  created_at: string
}

const COLS = 'id, name, kind, size_bytes, storage_path, parsed_path, sheets, summary, brief, conversation_id, created_at'

export async function insertChatFile(row: Omit<ChatFileRow, 'created_at' | 'conversation_id'>): Promise<ChatFileRow> {
  const res = await createServiceClient().from('agent_chat_files').insert(row).select(COLS).single()
  if (res.error || !res.data) throw new DbError('insertChatFile', res.error ?? new Error('no data'))
  return res.data as ChatFileRow
}

export async function getChatFile(id: string): Promise<ChatFileRow | null> {
  const res = await createServiceClient().from('agent_chat_files').select(COLS).eq('id', id).maybeSingle()
  if (res.error) throw new DbError('getChatFile', res.error)
  return (res.data as ChatFileRow | null) ?? null
}

/** The rows for `ids` that exist (any order). */
export async function getChatFiles(ids: string[]): Promise<ChatFileRow[]> {
  if (!ids.length) return []
  const res = await createServiceClient().from('agent_chat_files').select(COLS).in('id', ids)
  if (res.error) throw new DbError('getChatFiles', res.error)
  return (res.data ?? []) as ChatFileRow[]
}

/** Is this file attached to a message of this conversation? (read_attachment and lead tools are scoped to the chat.) */
export async function fileInConversation(fileId: string, conversationId: string): Promise<boolean> {
  const res = await createServiceClient()
    .from('agent_messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .contains('attachments', [{ kind: 'file', id: fileId }])
    .limit(1)
  if (res.error) throw new DbError('fileInConversation', res.error)
  return (res.data ?? []).length > 0
}

/** A row → the reference stored on a message. */
export const refOf = (r: Pick<ChatFileRow, 'id' | 'name' | 'kind' | 'size_bytes' | 'sheets'>): ChatFileRef => ({
  kind: 'file',
  id: r.id,
  name: r.name,
  file_kind: r.kind,
  size_bytes: r.size_bytes,
  sheets: r.sheets,
})
