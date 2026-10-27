import { describe, expect, it } from 'vitest'
import { maskKeyText, maskOperatorKeys } from '@/lib/operators/mask'

describe('maskOperatorKeys', () => {
  it('keeps the first 4 key characters of a sign-in link', () => {
    expect(maskKeyText('Open https://lume.app/auth/operator?k=abcdEFGH_ij-123 now')).toBe('Open https://lume.app/auth/operator?k=abcd**** now')
    expect(maskKeyText('/auth/operator?x=1&k=Zz9_LONGKEY')).toBe('/auth/operator?x=1&k=Zz9_****')
  })
  it('is idempotent and leaves other text alone', () => {
    const once = maskKeyText('…/auth/operator?k=abcdEFGH')
    expect(maskKeyText(once)).toBe(once)
    expect(maskKeyText('no key here; okay=1')).toBe('no key here; okay=1')
  })
  it('walks JSON deeply', () => {
    expect(
      maskOperatorKeys({ a: ['x?k=abcdefgh'], b: { c: 'y&k=12345678', n: 3, z: null }, t: true })
    ).toEqual({ a: ['x?k=abcd****'], b: { c: 'y&k=1234****', n: 3, z: null }, t: true })
  })
})
