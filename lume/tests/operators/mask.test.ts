import { describe, expect, it } from 'vitest'
import { maskKeyText, maskOperatorKeys } from '@/lib/operators/mask'

// Real keys: 32 random bytes, base64url → 43 characters.
const KEY = 'abcdEFGH_ij-123456789012345678901234567890z'
const KEY2 = 'Zz9_LONGKEYxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'

describe('maskKeyText (sign-in links only)', () => {
  it('masks the key of a sign-in link, keeping 4 characters', () => {
    expect(KEY).toHaveLength(43)
    expect(maskKeyText(`Open https://lume.app/auth/operator?k=${KEY} now`)).toBe('Open https://lume.app/auth/operator?k=abcd**** now')
    expect(maskKeyText(`/auth/operator?x=1&k=${KEY2}`)).toBe('/auth/operator?x=1&k=Zz9_****')
  })

  it('masks the URL-encoded form', () => {
    expect(maskKeyText(`next=%2Fauth%2Foperator%3Fk%3D${KEY}`)).toBe(`next=%2Fauth%2Foperator%3Fk%3Dabcd****`)
    expect(maskKeyText(`/auth/operator%3Fa%3D1%26k%3D${KEY}`)).toBe('/auth/operator%3Fa%3D1%26k%3Dabcd****')
  })

  it('leaves every other ?k= alone (search URLs, copy, webhook payloads)', () => {
    for (const s of [
      'https://www.amazon.com/s?k=laptops',
      `https://example.com/search?k=${KEY}`,
      'Reply with ?k=whatever in the subject',
      '/auth/operator?k=short',
    ]) expect(maskKeyText(s)).toBe(s)
  })

  it('a bare 43-character token is masked only when asked (agent text)', () => {
    expect(maskKeyText(`key ${KEY} here`)).toBe(`key ${KEY} here`)
    expect(maskKeyText(`key ${KEY} here`, { bare: true })).toBe('key abcd**** here')
    // Longer or shorter runs are not keys.
    const long = `${KEY}x`
    expect(maskKeyText(long, { bare: true })).toBe(long)
  })

  it('is idempotent', () => {
    const once = maskKeyText(`…/auth/operator?k=${KEY} and ${KEY2}`, { bare: true })
    expect(maskKeyText(once, { bare: true })).toBe(once)
    expect(once).toBe('…/auth/operator?k=abcd**** and Zz9_****')
  })
})

describe('maskOperatorKeys (deep)', () => {
  it('walks JSON and leaves non-key values alone', () => {
    expect(
      maskOperatorKeys({ a: [`x/auth/operator?k=${KEY}`], b: { c: 'https://amazon.com/s?k=laptops', n: 3, z: null }, t: true })
    ).toEqual({ a: ['x/auth/operator?k=abcd****'], b: { c: 'https://amazon.com/s?k=laptops', n: 3, z: null }, t: true })
  })
  it('bare tokens only with { bare: true }', () => {
    expect(maskOperatorKeys({ s: KEY })).toEqual({ s: KEY })
    expect(maskOperatorKeys({ s: KEY }, { bare: true })).toEqual({ s: 'abcd****' })
  })
})
