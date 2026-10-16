/**
 * Read a request body with a hard byte cap. A declared `Content-Length` over
 * the cap is refused before anything is read; otherwise the stream is
 * consumed chunk by chunk, counting bytes (not UTF-16 code units), and
 * cancelled as soon as it passes the cap.
 */
export type CappedBody = { ok: true; text: string } | { ok: false; reason: 'too_large' }
export type CappedBytes = { ok: true; bytes: Uint8Array } | { ok: false; reason: 'too_large' }

export async function readBytesCapped(req: Request, maxBytes: number): Promise<CappedBytes> {
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: 'too_large' }
  if (!req.body) return { ok: true, bytes: new Uint8Array(0) }

  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel('body too large').catch(() => {})
      return { ok: false, reason: 'too_large' }
    }
    chunks.push(value)
  }
  const buf = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    buf.set(c, off)
    off += c.byteLength
  }
  return { ok: true, bytes: buf }
}

export async function readBodyCapped(req: Request, maxBytes: number): Promise<CappedBody> {
  const r = await readBytesCapped(req, maxBytes)
  return r.ok ? { ok: true, text: new TextDecoder().decode(r.bytes) } : r
}
