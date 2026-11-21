import { describe, expect, it, vi } from 'vitest'
import { checkLimit, LIMITS } from '@/lib/mcp/limits'

const now = new Date('2026-11-20T12:00:00Z')

describe('checkLimit', () => {
  it('allows under the budget and counts from the right window', async () => {
    const count = vi.fn(async () => LIMITS.read.max - 1)
    expect(await checkLimit('read', count, now)).toEqual({ ok: true })
    expect(count).toHaveBeenCalledWith('read', '2026-11-20T11:59:00.000Z')
  })

  it('refuses at the budget', async () => {
    for (const cls of ['read', 'write', 'confirm'] as const) {
      const r = await checkLimit(cls, async () => LIMITS[cls].max, now)
      expect(r.ok).toBe(false)
    }
  })

  it('uses a one-hour window for confirms', async () => {
    const count = vi.fn(async () => 0)
    await checkLimit('confirm', count, now)
    expect(count).toHaveBeenCalledWith('confirm', '2026-11-20T11:00:00.000Z')
  })

  it('fails closed when the count errors', async () => {
    const r = await checkLimit('read', async () => {
      throw new Error('db down')
    }, now)
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/unavailable/) })
  })

  it('budgets match the spec', () => {
    expect(LIMITS.read).toMatchObject({ max: 60, windowMs: 60_000 })
    expect(LIMITS.write).toMatchObject({ max: 20, windowMs: 60_000 })
    expect(LIMITS.confirm).toMatchObject({ max: 10, windowMs: 3_600_000 })
  })
})
