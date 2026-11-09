import { describe, expect, it } from 'vitest'
import { nextRotation } from '@/lib/progress/bank'

describe('nextRotation', () => {
  it('is the next 01:00 or 13:00 UTC run', () => {
    expect(nextRotation(new Date('2026-11-09T22:10:00Z'))).toBe('2026-11-10T01:00:00.000Z')
    expect(nextRotation(new Date('2026-11-10T01:00:00Z'))).toBe('2026-11-10T13:00:00.000Z')
    expect(nextRotation(new Date('2026-11-10T00:59:00Z'))).toBe('2026-11-10T01:00:00.000Z')
  })
})
