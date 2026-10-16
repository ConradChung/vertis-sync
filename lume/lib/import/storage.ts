import 'server-only'

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

export async function uploadCsv(path: string, bytes: Uint8Array): Promise<void> {
  const { url, key } = cfg()
  const res = await fetch(objectUrl(url, path), {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'text/csv', 'x-upsert': 'false' },
    body: bytes as BodyInit,
    signal: AbortSignal.timeout(60_000),
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
