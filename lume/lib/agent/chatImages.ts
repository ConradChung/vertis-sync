import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { IMAGE_BUCKET, MAX_IMAGE_BYTES, sniffImageType, type ImageMediaType } from '@/lib/agent/images'

/**
 * The private `agent-chat-images` bucket (service role only; no Storage
 * policies, so anon / authenticated keys reach nothing). Objects live at
 * `<uuid>.<ext>` (IMAGE_PATH_RE); callers check the path and the owner first.
 */

export class ChatImageStorageError extends Error {
  constructor(op: string, detail: string) {
    super(`${IMAGE_BUCKET} ${op}: ${detail.slice(0, 200)}`)
    this.name = 'ChatImageStorageError'
  }
}

export async function storeChatImage(path: string, bytes: Uint8Array, mediaType: ImageMediaType): Promise<void> {
  const { error } = await createServiceClient().storage.from(IMAGE_BUCKET).upload(path, bytes, { contentType: mediaType, upsert: false })
  if (error) throw new ChatImageStorageError('upload', error.message)
}

/**
 * The stored bytes and their sniffed type; null when the object is missing,
 * over the cap, or (somehow) not an image. Throws on a Storage failure.
 */
export async function loadChatImage(path: string): Promise<{ bytes: Uint8Array; media_type: ImageMediaType } | null> {
  const { data, error } = await createServiceClient().storage.from(IMAGE_BUCKET).download(path)
  if (error || !data) {
    const status = (error as { status?: number } | null)?.status
    if (status === 400 || status === 404 || /not.?found/i.test(error?.message ?? '')) return null
    throw new ChatImageStorageError('download', error?.message ?? 'no data')
  }
  if (data.size > MAX_IMAGE_BYTES) return null
  const bytes = new Uint8Array(await data.arrayBuffer())
  const media_type = sniffImageType(bytes)
  return media_type ? { bytes, media_type } : null
}
