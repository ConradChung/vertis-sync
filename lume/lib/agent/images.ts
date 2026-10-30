/**
 * Images in the Agent chat (pure; shared by the browser and the routes).
 *
 * Flow: the composer downscales each image (long edge ≤ IMAGE_MAX_EDGE,
 * ≤ IMAGE_TARGET_BYTES) and uploads it, one request per image, to
 * `POST /api/agent/images`, which sniffs the magic bytes and stores it in the
 * private `agent-chat-images` bucket at `<uuid>.<ext>`. `/api/agent/run` then
 * gets only the paths, so no request body comes near Vercel's 4.5 MB cap.
 * The run reads the bytes back (service role), re-sniffs them, and sends them
 * to Claude as base64 `image` blocks; the message stores `{ path, name,
 * media_type }` in `agent_messages.attachments`. The browser shows them
 * through `GET /api/agent/images/<path>` (owner session).
 */

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

export const ACCEPTED_IMAGE_TYPES: readonly ImageMediaType[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

/** Images per message. */
export const MAX_IMAGES = 5
/** Long edge after the client downscale (Claude's own recommended maximum). */
export const IMAGE_MAX_EDGE = 1568
/** What the client re-encodes down to. */
export const IMAGE_TARGET_BYTES = 1.5 * 1024 * 1024
/** Server hard cap per image (the bucket's file_size_limit is the same). */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024
/** A file larger than this is refused before the browser even decodes it. */
export const RAW_IMAGE_MAX_BYTES = 30 * 1024 * 1024

export const IMAGE_BUCKET = 'agent-chat-images'

const EXT: Record<ImageMediaType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

/** `<uuid>.<ext>`: the only object paths the routes accept. */
export const IMAGE_PATH_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/

/** One image as stored on a message. */
export interface ChatImageRef {
  path: string
  name: string
  media_type: ImageMediaType
}

export function newImagePath(type: ImageMediaType): string {
  return `${crypto.randomUUID()}.${EXT[type]}`
}

/** The authed proxy that serves one stored image. */
export const imageUrl = (path: string) => `/api/agent/images/${path}`

const startsWith = (b: Uint8Array, sig: number[], at = 0) => b.length >= at + sig.length && sig.every((x, i) => b[at + i] === x)
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))

/** The type the bytes really are (never the client's claim), or null. */
export function sniffImageType(b: Uint8Array): ImageMediaType | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(b, ascii('GIF87a')) || startsWith(b, ascii('GIF89a'))) return 'image/gif'
  if (startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WEBP'), 8)) return 'image/webp'
  return null
}

export type ImageUploadCheck = { ok: true; media_type: ImageMediaType } | { ok: false; error: 'empty' | 'too_large' | 'unsupported_media_type' }

export function validateImageUpload(b: Uint8Array): ImageUploadCheck {
  if (!b.length) return { ok: false, error: 'empty' }
  if (b.length > MAX_IMAGE_BYTES) return { ok: false, error: 'too_large' }
  const media_type = sniffImageType(b)
  return media_type ? { ok: true, media_type } : { ok: false, error: 'unsupported_media_type' }
}

/** A display name: the base name only, no control characters, ≤ 120 chars. */
export function safeImageName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? ''
  const clean = base.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return (clean || 'image').slice(0, 120)
}

/** Dimensions with the long edge at most `max`, aspect ratio kept. */
export function fitWithin(width: number, height: number, max = IMAGE_MAX_EDGE): { width: number; height: number; scaled: boolean } {
  const long = Math.max(width, height)
  if (long <= max) return { width, height, scaled: false }
  const k = max / long
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)), scaled: true }
}

/** User-facing text for an upload / attach failure. */
export const IMAGE_ERRORS = {
  unsupported_media_type: 'is not a PNG, JPEG, GIF or WebP image',
  too_large: 'is too large, even after shrinking it',
  empty: 'is empty',
  decode: 'could not be read as an image',
  too_many: `Up to ${MAX_IMAGES} images per message`,
  upload: 'could not be uploaded',
} as const
