import { describe, expect, it } from 'vitest'
import {
  LFO_MAX_COUNT,
  LFO_MIN_COUNT,
  LUME_ALLOWED_ACTIONS,
  buildCallbackData,
  isLumeAction,
  parseCallbackData,
} from '@/lib/adapters/pipeline.actions'

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e'

describe('isLumeAction', () => {
  it('mirrors the telegram-inbox allowlist', () => {
    const expected = [
      'approve', 'approve_enrich', 'deny',
      'finder_go', 'finder_skip', 'wd_resume',
      'jobs_pull', 'jobs_skip', 'jobs_write', 'jobs_discard', 'jobs_resume', 'jobs_abort', 'jobs_order_now',
      'lfo_count', 'lfo_cancel', 'lfo_abort',
      'push_go', 'push_cancel', 'camp_launch',
      'lume_ok', 'lume_no',
    ]
    expect([...LUME_ALLOWED_ACTIONS].sort()).toEqual(expected.sort())
    for (const a of expected) expect(isLumeAction(a)).toBe(true)
  })

  it('rejects barrier toggles, navigation and junk', () => {
    for (const a of ['bar_loc', 'bar_co', 'push_strict', 'push_std', 'pick_campaign', 'camp_pick', 'lfo_custom', 'push_next', '', 'APPROVE', 'approve '])
      expect(isLumeAction(a)).toBe(false)
  })
})

describe('buildCallbackData', () => {
  it('builds action:uuid', () => {
    expect(buildCallbackData('approve', ID)).toBe(`approve:${ID}`)
    expect(buildCallbackData('lume_ok', ID)).toBe(`lume_ok:${ID}`)
  })

  it('builds lfo_count:uuid:n inside the 500–50000 bounds', () => {
    expect(buildCallbackData('lfo_count', ID, 500)).toBe(`lfo_count:${ID}:500`)
    expect(buildCallbackData('lfo_count', ID, '50000')).toBe(`lfo_count:${ID}:50000`)
    expect(LFO_MIN_COUNT).toBe(500)
    expect(LFO_MAX_COUNT).toBe(50000)
  })

  it('refuses lfo_count without a count or outside the bounds', () => {
    expect(() => buildCallbackData('lfo_count', ID)).toThrow()
    expect(() => buildCallbackData('lfo_count', ID, 499)).toThrow()
    expect(() => buildCallbackData('lfo_count', ID, 50001)).toThrow()
    expect(() => buildCallbackData('lfo_count', ID, '1e3')).toThrow()
    expect(() => buildCallbackData('lfo_count', ID, 750.5)).toThrow()
  })

  it('refuses non-allowlisted actions, bad ids and extras with separators', () => {
    expect(() => buildCallbackData('bar_loc', ID)).toThrow()
    expect(() => buildCallbackData('approve', 'not-a-uuid')).toThrow()
    expect(() => buildCallbackData('approve', `${ID}:x`)).toThrow()
    expect(() => buildCallbackData('jobs_pull', ID, 'a:b')).toThrow()
    expect(() => buildCallbackData('jobs_pull', ID, '')).toThrow()
  })
})

describe('parseCallbackData', () => {
  it('round-trips what buildCallbackData emits', () => {
    expect(parseCallbackData(`approve:${ID}`)).toEqual({ action: 'approve', targetId: ID, extra: undefined })
    expect(parseCallbackData(`lfo_count:${ID}:600`)).toEqual({ action: 'lfo_count', targetId: ID, extra: '600' })
  })

  it('rejects the same strings telegram-inbox rejects', () => {
    expect(parseCallbackData('')).toBeNull()
    expect(parseCallbackData('approve')).toBeNull()
    expect(parseCallbackData(`approve:${ID}:`)).toBeNull()
    expect(parseCallbackData(`approve:${ID}:a:b`)).toBeNull()
    expect(parseCallbackData(`bar_loc:${ID}`)).toBeNull()
    expect(parseCallbackData(`lfo_count:${ID}`)).toBeNull()
    expect(parseCallbackData(`lfo_count:${ID}:400`)).toBeNull()
    expect(parseCallbackData(`lfo_count:${ID}: 750`)).toBeNull()
  })
})
