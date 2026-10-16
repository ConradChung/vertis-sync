import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * Supabase Storage REST for the `raw-uploads` bucket (service role), the same
 * calls telegram-inbox makes. Lume writes only under `lume/`.
 */

const BUCKET = 'raw-uploads'

export class StorageError extends Error {
  readonly status: number
  constructor(op: string, status: number, detail: string) {
    super(`storage ${op}: HTTP ${status}${detail ? ` ${detail.slice(0, 200)}` : ''}`)
    this.name = 'StorageError'
    this.status = status
  }
}

function cfg(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  return { url: url.replace(/\/$/, ''), key }
}

/** Object path segments are encoded; `/` stays a separator. */
const objectUrl = (base: string, path: string) =>
  `${base}/storage/v1/object/${BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`

export async function uploadCsv(path: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
  const { url, key } = cfg()
  const timeout = AbortSignal.timeout(60_000)
  const res = await fetch(objectUrl(url, path), {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'text/csv', 'x-upsert': 'false' },
    body: bytes as BodyInit,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  if (!res.ok) throw new StorageError('upload', res.status, await res.text().catch(() => ''))
}

/** Best effort: used to clean up an upload whose ingest row could not be written. */
export async function removeObject(path: string): Promise<void> {
  const { url, key } = cfg()
  try {
    await fetch(`${url}/storage/v1/object/${BUCKET}`, {
      method: 'DELETE',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: [path] }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    console.error('[import] could not remove orphaned upload:', err instanceof Error ? err.message : err)
  }
}

/**
 * The first `maxBytes` of an object as text (a Range request, and the stream
 * is cancelled at the cap either way, so a 20 MB file is never pulled whole).
 * `null` when the object does not exist.
 */
export async function readObjectHead(path: string, maxBytes = 64 * 1024): Promise<{ text: string; truncated: boolean } | null> {
  const { url, key } = cfg()
  const res = await fetch(objectUrl(url, path), {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Range: `bytes=0-${maxBytes - 1}` },
    signal: AbortSignal.timeout(15_000),
  })
  if (res.status === 404 || res.status === 400) return null
  if (!res.ok) throw new StorageError('read', res.status, await res.text().catch(() => ''))
  if (!res.body) return { text: '', truncated: false }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  // Fewer bytes than asked for means the whole object arrived.
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.byteLength
    if (total >= maxBytes) {
      truncated = true
      await reader.cancel().catch(() => {})
      break
    }
  }
  const buf = new Uint8Array(Math.min(total, maxBytes))
  let off = 0
  for (const c of chunks) {
    const take = Math.min(c.byteLength, buf.length - off)
    buf.set(c.subarray(0, take), off)
    off += take
    if (off >= buf.length) break
  }
  return { text: new TextDecoder().decode(buf), truncated }
}

/** Object size from a HEAD, or `null` when it does not exist (Storage answers 400/404). */
export async function statObject(path: string): Promise<{ size: number } | null> {
  const { url, key } = cfg()
  const res = await fetch(objectUrl(url, path), {
    method: 'HEAD',
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  })
  if (res.status === 404 || res.status === 400) return null
  if (!res.ok) throw new StorageError('stat', res.status, '')
  const size = Number(res.headers.get('content-length'))
  return { size: Number.isFinite(size) ? size : 0 }
}

export interface ObjectScan {
  /** The first `headBytes` bytes (enough for the header line). */
  head: Uint8Array
  /** Data rows, counted exactly like telegram-inbox's `countDataRows`. */
  rows: number
  bytes: number
}

/**
 * Stream an object once: keep its first `headBytes`, count newline bytes, and
 * stop with `null` as soon as it passes `maxBytes`. Nothing beyond the head is
 * held in memory. `undefined` when the object does not exist.
 */
export async function scanObject(path: string, maxBytes: number, headBytes = 64 * 1024): Promise<ObjectScan | null | undefined> {
  const { url, key } = cfg()
  const res = await fetch(objectUrl(url, path), {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(60_000),
  })
  if (res.status === 404 || res.status === 400) return undefined
  if (!res.ok) throw new StorageError('scan', res.status, await res.text().catch(() => ''))
  const head = new Uint8Array(headBytes)
  let headLen = 0
  let total = 0
  let newlines = 0
  let last = -1
  if (res.body) {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        return null
      }
      if (headLen < headBytes) {
        const take = Math.min(value.byteLength, headBytes - headLen)
        head.set(value.subarray(0, take), headLen)
        headLen += take
      }
      for (let i = 0; i < value.byteLength; i++) if (value[i] === 10) newlines++
      last = value[value.byteLength - 1] ?? last
    }
  }
  const totalLines = total > 0 && last === 10 ? newlines : newlines + 1
  return { head: head.subarray(0, headLen), rows: total === 0 ? 0 : Math.max(0, totalLines - 1), bytes: total }
}

/** A one-time signed upload URL for `path` (the browser uploads straight to Storage). */
export async function createSignedUpload(path: string): Promise<{ signedUrl: string; token: string; path: string }> {
  const sb = createServiceClient()
  const { data, error } = await sb.storage.from(BUCKET).createSignedUploadUrl(path)
  if (error || !data) throw new StorageError('sign', 0, error?.message ?? 'no data')
  return { signedUrl: data.signedUrl, token: data.token, path: data.path }
}
