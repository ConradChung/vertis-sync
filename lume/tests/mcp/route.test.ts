import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The route must reject every method before the MCP handler sees the request:
// /api/mcp is public to the session middleware, so this check is the only gate.
const inner = vi.fn(async () => new Response('reached', { status: 200 }))
vi.mock('@/lib/mcp/server', () => ({ buildMcpHandler: () => inner }))

const TOKEN = 'k'.repeat(48)
const call = async (method: 'GET' | 'POST' | 'DELETE', auth?: string) => {
  const route = await import('@/app/api/mcp/route')
  const headers: Record<string, string> = {}
  if (auth !== undefined) headers.authorization = auth
  return route[method](new Request('http://localhost/api/mcp', { method, headers }))
}

beforeEach(() => {
  inner.mockClear()
  vi.stubEnv('LUME_MCP_TOKEN', TOKEN)
})
afterEach(() => vi.unstubAllEnvs())

describe('/api/mcp route token check', () => {
  for (const method of ['GET', 'POST', 'DELETE'] as const) {
    it(`${method}: 401 with no token, a wrong token, or a non-Bearer scheme; handler never runs`, async () => {
      for (const auth of [undefined, '', `Bearer ${'x'.repeat(48)}`, `Basic ${TOKEN}`, TOKEN]) {
        const res = await call(method, auth)
        expect(res.status).toBe(401)
        expect(await res.text()).toBe('{"error":"unauthorized"}')
      }
      expect(inner).not.toHaveBeenCalled()
    })

    it(`${method}: the right token reaches the handler`, async () => {
      const res = await call(method, `Bearer ${TOKEN}`)
      expect(res.status).toBe(200)
      expect(inner).toHaveBeenCalledTimes(1)
    })
  }

  it('fails closed when LUME_MCP_TOKEN is unset', async () => {
    vi.stubEnv('LUME_MCP_TOKEN', '')
    for (const method of ['GET', 'POST', 'DELETE'] as const) {
      expect((await call(method, 'Bearer ')).status).toBe(401)
      expect((await call(method, `Bearer ${TOKEN}`)).status).toBe(401)
    }
    expect(inner).not.toHaveBeenCalled()
  })
})
