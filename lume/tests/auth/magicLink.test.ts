import { describe, expect, it } from 'vitest'
import { shouldSendMagicLink } from '@/lib/auth/magicLink'

describe('shouldSendMagicLink', () => {
  it('sends for the owner, case-insensitively', () => {
    expect(shouldSendMagicLink('owner@example.com', 'owner@example.com')).toBe(true)
    expect(shouldSendMagicLink('Owner@Example.com', 'owner@example.com')).toBe(true)
  })

  it('does not send for anyone else', () => {
    expect(shouldSendMagicLink('intruder@example.com', 'owner@example.com')).toBe(false)
  })

  it('does not send when the allowed email is unset (fail closed)', () => {
    expect(shouldSendMagicLink('owner@example.com', undefined)).toBe(false)
    expect(shouldSendMagicLink('owner@example.com', '')).toBe(false)
  })

  it('does not send for a missing or malformed email', () => {
    expect(shouldSendMagicLink(undefined, 'owner@example.com')).toBe(false)
    expect(shouldSendMagicLink('', 'owner@example.com')).toBe(false)
    expect(shouldSendMagicLink('not-an-email', 'not-an-email')).toBe(false)
  })
})
