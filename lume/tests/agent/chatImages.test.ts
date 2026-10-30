import { beforeEach, describe, expect, it, vi } from 'vitest'
import { png } from '../stubs/imageHeaders'

/** loadChatImage re-checks what Storage hands back: a stored image that would fail the API is treated as gone. */
const store = vi.hoisted(() => ({ blob: null as Blob | null, error: null as { message: string; status?: number } | null }))
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({ storage: { from: () => ({ download: async () => ({ data: store.blob, error: store.error }) }) } }),
}))

import { loadChatImage } from '@/lib/agent/chatImages'

const P = '0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c.png'
beforeEach(() => {
  store.blob = null
  store.error = null
})

describe('loadChatImage', () => {
  it('returns the bytes and sniffed type of a valid image', async () => {
    store.blob = new Blob([png(100, 50)])
    expect(await loadChatImage(P)).toMatchObject({ media_type: 'image/png' })
  })
  it('treats an oversize-dimension or unreadable stored image as missing', async () => {
    store.blob = new Blob([png(9000, 50)])
    expect(await loadChatImage(P)).toBeNull()
    store.blob = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])])
    expect(await loadChatImage(P)).toBeNull()
  })
  it('a missing object is null; another Storage failure throws', async () => {
    store.error = { message: 'Object not found', status: 404 }
    expect(await loadChatImage(P)).toBeNull()
    store.error = { message: 'boom', status: 500 }
    await expect(loadChatImage(P)).rejects.toThrow(/download/)
  })
})
