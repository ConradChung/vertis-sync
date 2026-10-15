import { describe, expect, it } from 'vitest'
import { isOwner } from '@/lib/auth/isOwner'

describe('isOwner', () => {
  it('matches the allowed email exactly', () => {
    expect(isOwner('owner@example.com', 'owner@example.com')).toBe(true)
  })

  it('is case-insensitive on both sides', () => {
    expect(isOwner('Owner@Example.com', 'owner@example.com')).toBe(true)
    expect(isOwner('owner@example.com', 'OWNER@EXAMPLE.COM')).toBe(true)
  })

  it('ignores surrounding whitespace in the allowed value (env files)', () => {
    expect(isOwner('owner@example.com', ' owner@example.com\n')).toBe(true)
  })

  it('is false for a different email', () => {
    expect(isOwner('intruder@example.com', 'owner@example.com')).toBe(false)
  })

  it('is false when the user email is undefined', () => {
    expect(isOwner(undefined, 'owner@example.com')).toBe(false)
  })

  it('is false when the allowed email is undefined or empty (never fail open)', () => {
    expect(isOwner('owner@example.com', undefined)).toBe(false)
    expect(isOwner('owner@example.com', '')).toBe(false)
    expect(isOwner(undefined, undefined)).toBe(false)
    expect(isOwner('', '')).toBe(false)
  })
})
