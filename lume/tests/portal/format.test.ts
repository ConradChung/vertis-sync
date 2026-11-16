import { describe, expect, it } from 'vitest'
import { externalHref, localTime, locationLabel, phoneHref } from '@/components/portal/format'

describe('phoneHref', () => {
  it('strips spaces, dashes, dots and brackets, keeping a leading +', () => {
    expect(phoneHref('+1 (214) 555-0100')).toBe('tel:+12145550100')
    expect(phoneHref('214.555.0100')).toBe('tel:2145550100')
    expect(phoneHref(' +44 20 7946 0958 ')).toBe('tel:+442079460958')
  })
  it('turns an extension into a dial pause', () => {
    expect(phoneHref('(214) 555-0100 x204')).toBe('tel:2145550100,204')
    expect(phoneHref('214-555-0100 ext. 7')).toBe('tel:2145550100,7')
  })
  it('returns null for nothing dialable', () => {
    expect(phoneHref(null)).toBeNull()
    expect(phoneHref('')).toBeNull()
    expect(phoneHref('n/a')).toBeNull()
  })
})

describe('externalHref', () => {
  it('adds https to bare domains and refuses other schemes', () => {
    expect(externalHref('acme.com')).toBe('https://acme.com')
    expect(externalHref('http://acme.com')).toBe('http://acme.com')
    expect(externalHref('javascript:alert(1)')).toBeNull()
    expect(externalHref(null)).toBeNull()
  })
})

describe('localTime', () => {
  // Wed 2026-11-11 15:41 UTC
  const wed = new Date('2026-11-11T15:41:00Z')
  // Sat 2026-11-14 15:41 UTC
  const sat = new Date('2026-11-14T15:41:00Z')

  it('formats the wall clock per zone', () => {
    expect(localTime('America/Chicago', wed)?.time).toBe('9:41 AM')
    expect(localTime('America/New_York', wed)?.time).toBe('10:41 AM')
    expect(localTime('Europe/London', wed)?.time).toBe('3:41 PM')
    expect(localTime('Asia/Tokyo', wed)?.time).toBe('12:41 AM')
  })

  it('flags Mon–Fri 8:00–17:59 local as business hours', () => {
    expect(localTime('America/Chicago', wed)?.business).toBe(true)
    expect(localTime('Asia/Tokyo', wed)?.business).toBe(false) // 00:41 Thu
    expect(localTime('America/Los_Angeles', new Date('2026-11-11T15:59:00Z'))?.business).toBe(false) // 07:59
    expect(localTime('America/Los_Angeles', new Date('2026-11-11T16:00:00Z'))?.business).toBe(true) // 08:00
    expect(localTime('America/Chicago', new Date('2026-11-12T00:00:00Z'))?.business).toBe(false) // 18:00
    expect(localTime('America/Chicago', sat)?.business).toBe(false) // Saturday
  })

  it('returns null for a missing or unknown zone', () => {
    expect(localTime(null, wed)).toBeNull()
    expect(localTime('Mars/Olympus_Mons', wed)).toBeNull()
  })
})

describe('locationLabel', () => {
  it('prefers state over country and drops blanks', () => {
    expect(locationLabel({ city: 'Dallas', state: 'TX', country: 'US' })).toBe('Dallas, TX')
    expect(locationLabel({ city: 'Lyon', state: null, country: 'France' })).toBe('Lyon, France')
    expect(locationLabel({ city: null, state: null, country: null })).toBeNull()
  })
})
