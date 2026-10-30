/**
 * Browser side of chat images: shrink, then upload one at a time.
 *
 * prepareImage: sniffs the first bytes (the browser's File.type is not
 * trusted here either), refuses anything over RAW_IMAGE_MAX_BYTES before
 * decoding, and keeps an image that already fits (long edge ≤ 1568 px and
 * ≤ IMAGE_TARGET_BYTES) byte for byte. Otherwise it redraws it on a canvas at
 * the fitted size: PNG first for PNG / GIF sources (screenshots stay crisp),
 * then JPEG at falling quality, then a 25 % smaller size, up to four rounds.
 *
 * uploadChatImage: `POST /api/agent/images?name=…` with the raw bytes; the
 * server sniffs them again and answers `{ path, name, media_type }`.
 */
import {
  fitWithin,
  IMAGE_TARGET_BYTES,
  RAW_IMAGE_MAX_BYTES,
  sniffImageType,
  type ChatImageRef,
  type ImageMediaType,
} from '@/lib/agent/images'

export interface DecodedImage {
  width: number
  height: number
  encode: (width: number, height: number, type: 'image/png' | 'image/jpeg', quality?: number) => Promise<Blob | null>
  close: () => void
}

export interface ImageCodec {
  decode: (file: Blob) => Promise<DecodedImage>
}

export type PrepareError = 'unsupported_media_type' | 'too_large' | 'decode'
export type Prepared = { ok: true; blob: Blob; name: string; media_type: ImageMediaType } | { ok: false; error: PrepareError }

const JPEG_QUALITIES = [0.9, 0.8, 0.7, 0.6, 0.5]
const ROUNDS = 4

/** Canvas codec (the real one). JPEG gets a white backdrop so transparency doesn't turn black. */
export const canvasCodec: ImageCodec = {
  async decode(file) {
    const bmp = await createImageBitmap(file)
    return {
      width: bmp.width,
      height: bmp.height,
      encode: (width, height, type, quality) => {
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        if (!ctx) return Promise.resolve(null)
        if (type === 'image/jpeg') {
          ctx.fillStyle = '#fff'
          ctx.fillRect(0, 0, width, height)
        }
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(bmp, 0, 0, width, height)
        return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
      },
      close: () => bmp.close(),
    }
  },
}

const withExt = (name: string, ext: string) => (/\.[a-z0-9]{1,5}$/i.test(name) ? name.replace(/\.[a-z0-9]{1,5}$/i, `.${ext}`) : `${name}.${ext}`)

export async function prepareImage(file: File, codec: ImageCodec = canvasCodec): Promise<Prepared> {
  if (file.size > RAW_IMAGE_MAX_BYTES) return { ok: false, error: 'too_large' }
  const media_type = sniffImageType(new Uint8Array(await file.slice(0, 16).arrayBuffer()))
  if (!media_type) return { ok: false, error: 'unsupported_media_type' }
  const name = file.name || `image.${media_type.split('/')[1]}`

  let img: DecodedImage
  try {
    img = await codec.decode(file)
  } catch {
    return { ok: false, error: 'decode' }
  }
  try {
    const fit = fitWithin(img.width, img.height)
    if (!fit.scaled && file.size <= IMAGE_TARGET_BYTES) return { ok: true, blob: file, name, media_type }
    let { width, height } = fit
    const lossless = media_type === 'image/png' || media_type === 'image/gif'
    for (let round = 0; round < ROUNDS; round++) {
      if (lossless) {
        const png = await img.encode(width, height, 'image/png')
        if (png && png.size <= IMAGE_TARGET_BYTES) return { ok: true, blob: png, name: withExt(name, 'png'), media_type: 'image/png' }
      }
      for (const q of JPEG_QUALITIES) {
        const jpg = await img.encode(width, height, 'image/jpeg', q)
        if (jpg && jpg.size <= IMAGE_TARGET_BYTES) return { ok: true, blob: jpg, name: withExt(name, 'jpg'), media_type: 'image/jpeg' }
      }
      width = Math.max(1, Math.round(width * 0.75))
      height = Math.max(1, Math.round(height * 0.75))
    }
    return { ok: false, error: 'too_large' }
  } catch {
    return { ok: false, error: 'decode' }
  } finally {
    img.close()
  }
}

export type UploadError = 'unsupported_media_type' | 'too_large' | 'empty' | 'unreadable' | 'too_many_pixels' | 'upload'

const UPLOAD_ERRORS: readonly string[] = ['unsupported_media_type', 'too_large', 'empty', 'unreadable', 'too_many_pixels']

export async function uploadChatImage(blob: Blob, name: string): Promise<{ ok: true; ref: ChatImageRef } | { ok: false; error: UploadError }> {
  try {
    const res = await fetch(`/api/agent/images?name=${encodeURIComponent(name)}`, { method: 'POST', credentials: 'same-origin', body: blob })
    const body = (await res.json().catch(() => ({}))) as Partial<ChatImageRef> & { error?: string }
    if (res.ok && body.path && body.media_type) return { ok: true, ref: { path: body.path, name: body.name ?? name, media_type: body.media_type } }
    const e = body.error
    return { ok: false, error: e && UPLOAD_ERRORS.includes(e) ? (e as UploadError) : 'upload' }
  } catch {
    return { ok: false, error: 'upload' }
  }
}
