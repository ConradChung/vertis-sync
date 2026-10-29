import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StorageClient } from '@supabase/storage-js'

/**
 * The upload goes through the real storage-js client (only fetch is stubbed),
 * so the test sees the request the browser would actually send to Storage.
 */
const sent = vi.hoisted(() => ({ storage: [] as { url: string; init: RequestInit }[] }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    storage: new StorageClient('https://proj.supabase.co/storage/v1', {}, (async (url: string, init: RequestInit) => {
      sent.storage.push({ url: String(url), init })
      return Response.json({ Key: 'agent-projects/x' })
    }) as typeof fetch),
  }),
}))

import { uploadProjectFile } from '@/lib/agent/projectClient'

const PID = '0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b01'

beforeEach(() => {
  sent.storage = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.endsWith('/files/sign')) return Response.json({ path: `${PID}/abc.bin`, token: 'tok', upload_ticket: 't' })
      return Response.json({ item: { id: 'f1' } }, { status: 201 })
    })
  )
})

const headerOf = (init: RequestInit, name: string) => new Headers(init.headers).get(name)

describe('uploadProjectFile → Storage request', () => {
  it.each([
    ['notes.md', '', 'text/markdown'],
    ['notes.txt', 'application/octet-stream', 'text/plain'],
    ['leads.csv', 'application/vnd.ms-excel', 'text/csv'],
    ['data.json', '', 'application/json'],
    ['deck.pdf', 'application/pdf', 'application/pdf'],
    ['logo.png', 'image/png', 'image/png'],
  ])('%s (browser type %j) is sent raw with Content-Type %s', async (name, browserType, expected) => {
    const file = new File(['hello'], name, { type: browserType })
    const r = await uploadProjectFile(PID, file)
    expect(r.ok).toBe(true)
    expect(sent.storage).toHaveLength(1)
    const { init } = sent.storage[0]
    expect(init.method).toBe('PUT')
    // Not multipart: a FormData/Blob body would carry the browser's File.type instead.
    expect(init.body instanceof FormData).toBe(false)
    expect(init.body instanceof Blob).toBe(false)
    expect(headerOf(init, 'content-type')).toBe(expected)
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe('hello')
  })
})
