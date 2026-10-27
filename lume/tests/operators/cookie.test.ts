import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { cookieFromHeader, signOperatorCookie, verifyOperatorCookie } from '@/lib/operators/cookie'

const ID = '0a4c1e2f-5b6d-4e7f-8a9b-0c1d2e3f4a5b'
const OTHER = '7db3d841-252c-4572-95ec-bc110727df8d'
const SECRET = 's'.repeat(32)

describe('lume_op cookie', () => {
  it('round-trips: <id>.<base64url hmac>', () => {
    const v = signOperatorCookie(ID, SECRET)
    expect(v).toMatch(new RegExp(`^${ID}\\.[A-Za-z0-9_-]{43}$`))
    expect(verifyOperatorCookie(v, SECRET)).toBe(ID)
  })

  it('rejects tampering: swapped id, edited mac, wrong secret', () => {
    const v = signOperatorCookie(ID, SECRET)
    const mac = v.split('.')[1]
    expect(verifyOperatorCookie(`${OTHER}.${mac}`, SECRET)).toBeNull()
    const flipped = mac.slice(0, -1) + (mac.endsWith('A') ? 'B' : 'A')
    expect(verifyOperatorCookie(`${ID}.${flipped}`, SECRET)).toBeNull()
    expect(verifyOperatorCookie(v, 'another-secret')).toBeNull()
  })

  it('rejects missing, malformed, or unsigned values and a missing secret', () => {
    for (const bad of [null, undefined, '', ID, `${ID}.`, `.${'a'.repeat(43)}`, `not-a-uuid.${'a'.repeat(43)}`, `${ID}.short`]) {
      expect(verifyOperatorCookie(bad, SECRET)).toBeNull()
    }
    expect(verifyOperatorCookie(signOperatorCookie(ID, SECRET), undefined)).toBeNull()
    expect(() => signOperatorCookie(ID, '')).toThrow()
  })

  it('keys the HMAC with HMAC_SHA256(secret, "lume_op"), never the raw secret', () => {
    const derived = createHmac('sha256', SECRET).update('lume_op').digest()
    const expected = createHmac('sha256', derived).update(ID).digest('base64url')
    expect(signOperatorCookie(ID, SECRET)).toBe(`${ID}.${expected}`)
    // A cookie minted the old way (raw secret as the key) no longer verifies.
    const legacy = `${ID}.${createHmac('sha256', SECRET).update(ID).digest('base64url')}`
    expect(verifyOperatorCookie(legacy, SECRET)).toBeNull()
  })

  it('reads one cookie from a Cookie header', () => {
    expect(cookieFromHeader('a=1; lume_op=x.y; b=2', 'lume_op')).toBe('x.y')
    expect(cookieFromHeader('a=1', 'lume_op')).toBeNull()
    expect(cookieFromHeader(null, 'lume_op')).toBeNull()
  })
})
