import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { storeChatImage } from '@/lib/agent/chatImages'
import { MAX_IMAGE_BYTES, newImagePath, safeImageName, validateImageUpload } from '@/lib/agent/images'
import { readBytesCapped } from '@/lib/http/readBody'

/**
 * POST `?name=<file name>` with the image bytes as the raw body → `{ path,
 * name, media_type }`. One image per request, ≤ MAX_IMAGE_BYTES (2 MB), so a
 * message's images never share one request body (Vercel caps those at
 * 4.5 MB). The type comes from the magic bytes, never the Content-Type or the
 * name; png / jpeg / gif / webp only. Stored in the private
 * `agent-chat-images` bucket; `/api/agent/run` takes the returned paths.
 * Same guard as `/api/agent/run`.
 */

export const runtime = 'nodejs'

const STATUS = { empty: 400, too_large: 413, unsupported_media_type: 415 } as const

export async function POST(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response

  const body = await readBytesCapped(req, MAX_IMAGE_BYTES)
  if (!body.ok) return NextResponse.json({ error: 'too_large' }, { status: 413 })
  const check = validateImageUpload(body.bytes)
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: STATUS[check.error] })

  const name = safeImageName(new URL(req.url).searchParams.get('name') ?? '')
  const path = newImagePath(check.media_type)
  try {
    await storeChatImage(path, body.bytes, check.media_type)
  } catch (err) {
    console.error('[api/agent/images] store failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'storage' }, { status: 502 })
  }
  return NextResponse.json({ path, name, media_type: check.media_type })
}
