import { describe, expect, it } from 'vitest'
import { describeCycle, parseCycleParams, refillCount } from '@/lib/rules/cycle'

describe('cycle-out params', () => {
  it('defaults after_days to 14; refill_to optional', () => {
    expect(parseCycleParams({})).toEqual({ after_days: 14 })
    expect(parseCycleParams({ after_days: 21, refill_to: 900 })).toEqual({ after_days: 21, refill_to: 900 })
  })
  it('refuses bad values and unknown keys', () => {
    expect(parseCycleParams({ after_days: 0 })).toBeNull()
    expect(parseCycleParams({ after_days: 14, refill_to: 0 })).toBeNull()
    expect(parseCycleParams({ after_days: 14, extra: 1 })).toBeNull()
  })
  it('describes itself', () => {
    expect(describeCycle({ after_days: 14, refill_to: 1000 })).toBe(
      'remove leads whose sequence finished 14+ days ago with no reply, then refill to 1,000 leads from the lead bank'
    )
  })
})

describe('refillCount', () => {
  it('fills the gap to the target, counting queued leads, capped by what is available', () => {
    expect(refillCount({ refillTo: 1000, inCampaign: 700, queued: 100, available: 5000 })).toBe(200)
    expect(refillCount({ refillTo: 1000, inCampaign: 700, queued: 100, available: 50 })).toBe(50)
    expect(refillCount({ refillTo: 500, inCampaign: 700, queued: 0, available: 50 })).toBe(0)
  })
})
