import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({}) }))
import { scanObject, statObject } from '@/lib/import/storage'
import { countDataRows } from '@/lib/import/csv'

const fetchMock = vi.fn()
beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://p.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc'
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

const stream = (parts: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of parts) c.enqueue(new TextEncoder().encode(p))
      c.close()
    },
  })

describe('storage scan/stat', () => {
  it.each([
    [['a,b\n1,2\n', '3,4\n']],
    [['a,b\n1,2\n3,', '4']],
    [['a,b\n']],
    [['']],
  ])('scanObject counts rows like countDataRows across chunks: %j', async (parts) => {
    fetchMock.mockResolvedValue(new Response(stream(parts)))
    const r = await scanObject('lume/x.csv', 1024, 4)
    expect(r?.rows).toBe(countDataRows(new TextEncoder().encode(parts.join(''))))
    expect(new TextDecoder().decode(r!.head)).toBe(parts.join('').slice(0, 4))
  })

  it('scanObject: null over the cap, undefined when missing', async () => {
    fetchMock.mockResolvedValue(new Response(stream(['x'.repeat(50)])))
    expect(await scanObject('lume/x.csv', 10)).toBeNull()
    fetchMock.mockResolvedValue(new Response('{"error":"not_found"}', { status: 400 }))
    expect(await scanObject('lume/x.csv', 10)).toBeUndefined()
  })

  it('statObject reads the HEAD size; missing → null', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200, headers: { 'content-length': '1234' } }))
    expect(await statObject('lume/x.csv')).toEqual({ size: 1234 })
    expect(fetchMock.mock.calls[0][1].method).toBe('HEAD')
    fetchMock.mockResolvedValue(new Response(null, { status: 400 }))
    expect(await statObject('lume/x.csv')).toBeNull()
  })
})
