import { describe, expect, it } from 'vitest'
import { checkMcpAuth, MIN_TOKEN_LENGTH } from '@/lib/mcp/auth'

const TOKEN = 'a'.repeat(MIN_TOKEN_LENGTH) + 'Zq9'
const req = (auth?: string) => new Request('http://x/api/mcp', { method: 'POST', headers: auth ? { authorization: auth } : {} })

describe('checkMcpAuth', () => {
  it('lets the right bearer token through', () => {
    expect(checkMcpAuth(req(`Bearer ${TOKEN}`), TOKEN)).toBeNull()
    expect(checkMcpAuth(req(`bearer ${TOKEN}`), TOKEN)).toBeNull()
  })

  it.each([
    ['no header', undefined],
    ['wrong token', `Bearer ${TOKEN}x`],
    ['token without scheme', TOKEN],
    ['basic scheme', `Basic ${TOKEN}`],
    ['empty bearer', 'Bearer '],
    ['two tokens', `Bearer ${TOKEN} ${TOKEN}`],
  ])('401s with %s', async (_label, header) => {
    const res = checkMcpAuth(req(header), TOKEN)
    expect(res?.status).toBe(401)
    expect(res?.headers.get('www-authenticate')).toMatch(/^Bearer/)
    const body = await res!.text()
    expect(body).toBe('{"error":"unauthorized"}')
    expect(body).not.toContain(TOKEN)
  })

  it('fails closed when the token is unset or too short', () => {
    expect(checkMcpAuth(req('Bearer short'), 'short')?.status).toBe(401)
    expect(checkMcpAuth(req('Bearer x'), undefined)?.status).toBe(401)
    expect(checkMcpAuth(req('Bearer '), '')?.status).toBe(401)
  })
})
