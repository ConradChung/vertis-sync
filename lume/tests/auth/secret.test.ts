import { describe, expect, it } from 'vitest'
import { secretMatches } from '@/lib/auth/secret'

describe('secretMatches', () => {
  it('is true for identical non-empty values', () => {
    expect(secretMatches('abc123', 'abc123')).toBe(true)
  })

  it('is false for different values, including different lengths', () => {
    expect(secretMatches('abc123', 'abc124')).toBe(false)
    expect(secretMatches('abc', 'abc123')).toBe(false)
  })

  it('never passes when either side is missing or empty', () => {
    expect(secretMatches(undefined, 'abc')).toBe(false)
    expect(secretMatches(null, 'abc')).toBe(false)
    expect(secretMatches('abc', undefined)).toBe(false)
    expect(secretMatches('', '')).toBe(false)
    expect(secretMatches(undefined, undefined)).toBe(false)
  })
})
