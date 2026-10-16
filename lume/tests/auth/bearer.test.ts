import { describe, expect, it } from 'vitest'
import { bearerMatches, bearerToken, hasBearerToken } from '@/lib/auth/bearer'
import { internalBearerMatches } from '@/lib/auth/internalBearer'

describe('hasBearerToken / bearerToken (middleware shape check)', () => {
  it('accepts any non-empty bearer, regardless of validity', () => {
    expect(hasBearerToken('Bearer abc')).toBe(true)
    expect(hasBearerToken('bearer abc')).toBe(true)
    expect(hasBearerToken('  Bearer abc  ')).toBe(true)
    expect(bearerToken('  Bearer abc  ')).toBe('abc')
  })

  it('is false for no header, other schemes and an empty token', () => {
    for (const h of [null, undefined, '', 'Bearer', 'Bearer ', 'Basic abc', 'abc', 'Bearer a b']) {
      expect(hasBearerToken(h), String(h)).toBe(false)
      expect(bearerToken(h), String(h)).toBeNull()
    }
  })
})

describe('bearerMatches (Edge, Web Crypto)', () => {
  it('matches only the exact configured secret', async () => {
    expect(await bearerMatches('Bearer top-secret', 'top-secret')).toBe(true)
    expect(await bearerMatches('bearer top-secret', 'top-secret')).toBe(true)
    expect(await bearerMatches('Bearer wrong', 'top-secret')).toBe(false)
    expect(await bearerMatches('Bearer top-secret-', 'top-secret')).toBe(false)
    expect(await bearerMatches('Bearer top-secre', 'top-secret')).toBe(false)
  })

  it('fails closed on a missing header or an unset secret', async () => {
    expect(await bearerMatches(null, 'top-secret')).toBe(false)
    expect(await bearerMatches('Bearer top-secret', undefined)).toBe(false)
    expect(await bearerMatches('Bearer top-secret', '')).toBe(false)
    expect(await bearerMatches('Basic top-secret', 'top-secret')).toBe(false)
  })
})

/**
 * Property: whatever header `hasBearerToken` accepts, both matchers (the Edge
 * one and the Node one behind requireOwner) parse the same token out of it,
 * so a request can never pass the middleware's shape check and then be
 * mis-parsed by the route, or vice versa.
 */
describe('property: accepted headers are parsed by both matchers', () => {
  // Deterministic LCG so a failure is reproducible without a dependency.
  let seed = 0x2f6e2b1
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]
  const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.~+/='
  const token = () => Array.from({ length: 1 + Math.floor(rand() * 64) }, () => pick([...ALPHABET])).join('')
  const ws = () => pick([' ', '  ', '\t', ' \t '])
  const scheme = () => pick(['Bearer', 'bearer', 'BEARER', 'bEaReR'])

  it('holds for 500 generated headers', async () => {
    for (let i = 0; i < 500; i++) {
      const t = token()
      const header = `${pick(['', ' '])}${scheme()}${ws()}${t}${pick(['', ' ', '\t'])}`
      expect(hasBearerToken(header), header).toBe(true)
      expect(bearerToken(header), header).toBe(t)
      expect(await bearerMatches(header, t), header).toBe(true)
      expect(internalBearerMatches(header, t), header).toBe(true)
      // and a one-character change to the secret is rejected by both
      const other = t.length > 1 ? t.slice(0, -1) : t + 'x'
      expect(await bearerMatches(header, other), header).toBe(false)
      expect(internalBearerMatches(header, other), header).toBe(false)
    }
  })

  it('headers hasBearerToken rejects never match either matcher', async () => {
    for (let i = 0; i < 200; i++) {
      const t = token()
      const header = pick([`Basic ${t}`, `Bearer`, `Bearer ${t} extra`, t, `Token ${t}`, ''])
      expect(hasBearerToken(header), header).toBe(false)
      expect(await bearerMatches(header, t), header).toBe(false)
      expect(internalBearerMatches(header, t), header).toBe(false)
    }
  })
})
