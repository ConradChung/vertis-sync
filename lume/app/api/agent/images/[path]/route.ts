import { NextResponse } from 'next/server'
import { requireOwnerSession } from '@/lib/auth/guards'
import { loadChatImage } from '@/lib/agent/chatImages'
import { IMAGE_PATH_RE } from '@/lib/agent/images'

/**
 * GET one chat image (owner session only, the same check the conversation
 * load uses). Streams the private object through this route instead of
 * handing out a signed URL, so a copied link is useless without the session.
 * The type is re-sniffed from the bytes; `nosniff` + a sandbox CSP keep the
 * browser from treating it as anything but an image.
 */

export const runtime = 'nodejs'

type Ctx = { params: Promise<{ path: string }> }

export async function GET(req: Request, ctx: Ctx) {
  const auth = await requireOwnerSession(req)
  if (!auth.ok) return auth.response
  const path = (await ctx.params).path
  if (!IMAGE_PATH_RE.test(path)) return NextResponse.json({ error: 'invalid_path' }, { status: 400 })
  let img
  try {
    img = await loadChatImage(path)
  } catch (err) {
    console.error('[api/agent/images/[path]] load failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'storage' }, { status: 502 })
  }
  if (!img) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return new Response(new Blob([img.bytes as BlobPart], { type: img.media_type }), {
    headers: {
      'Content-Type': img.media_type,
      'Content-Length': String(img.bytes.byteLength),
      // Paths are random and never rewritten, so the bytes behind one never change.
      'Cache-Control': 'private, max-age=86400, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': 'inline',
    },
  })
}
