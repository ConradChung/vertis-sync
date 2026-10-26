import { describe, expect, it } from 'vitest'
import { autoAdvance, conversions, DEFAULT_STAGES, planStageMove, requiresApproval } from '@/lib/crm/stages'

describe('planStageMove (user moves)', () => {
  it('Won and Lost need approval with a reason', () => {
    expect(planStageMove('Interested', 'Won', 'signed pilot')).toEqual({ type: 'approval', to: 'Won', reason: 'signed pilot' })
    expect(planStageMove('Replied', 'Lost', '  no budget ')).toEqual({ type: 'approval', to: 'Lost', reason: 'no budget' })
  })
  it('Won/Lost without a reason is refused', () => {
    expect(planStageMove('Replied', 'Won', '')).toEqual({ type: 'error', error: 'reason_required' })
    expect(planStageMove('Replied', 'Lost', null)).toEqual({ type: 'error', error: 'reason_required' })
  })
  it('every other stage is direct, including backwards and side exits', () => {
    for (const to of ['Contacted', 'Replied', 'Interested', 'Meeting booked', 'Bounced', 'Not now']) {
      expect(planStageMove('Won' === to ? 'Lost' : 'Interested', to, null).type).toMatch(/direct|noop/)
    }
    expect(planStageMove('Meeting booked', 'Replied', null)).toEqual({ type: 'direct', to: 'Replied' })
    expect(planStageMove('Contacted', 'Not now', undefined)).toEqual({ type: 'direct', to: 'Not now' })
  })
  it('same stage is a no-op; unknown stages are refused', () => {
    expect(planStageMove('Replied', 'Replied', null)).toEqual({ type: 'noop' })
    expect(planStageMove('Replied', 'Negotiating', null)).toEqual({ type: 'error', error: 'unknown_stage' })
  })
  it('requiresApproval is exactly Won/Lost', () => {
    expect(DEFAULT_STAGES.filter((s) => requiresApproval(s.name)).map((s) => s.name)).toEqual(['Won', 'Lost'])
  })
})

describe('autoAdvance (automation)', () => {
  it('reply / interest / meeting move forward only', () => {
    expect(autoAdvance('Contacted', 'replied')).toBe('Replied')
    expect(autoAdvance('Contacted', 'interested')).toBe('Interested')
    expect(autoAdvance('Replied', 'interested')).toBe('Interested')
    expect(autoAdvance('Interested', 'replied')).toBeNull()
    expect(autoAdvance('Meeting booked', 'interested')).toBeNull()
    expect(autoAdvance('Interested', 'meeting')).toBe('Meeting booked')
  })
  it('never closes a deal and never touches a closed one', () => {
    for (const sig of ['sent', 'opened', 'replied', 'interested', 'bounced', 'meeting'] as const) {
      expect(['Won', 'Lost']).not.toContain(autoAdvance('Meeting booked', sig))
      expect(autoAdvance('Won', sig)).toBeNull()
      expect(autoAdvance('Lost', sig)).toBeNull()
      expect(autoAdvance('Bounced', sig)).toBeNull()
    }
  })
  it('bounce moves any open deal to Bounced', () => {
    expect(autoAdvance('Contacted', 'bounced')).toBe('Bounced')
    expect(autoAdvance('Not now', 'bounced')).toBe('Bounced')
  })
  it('sends and opens never move a stage', () => {
    expect(autoAdvance('Contacted', 'sent')).toBeNull()
    expect(autoAdvance('Contacted', 'opened')).toBeNull()
  })
  it('a reply brings Not now back to the main line; custom stages are left alone', () => {
    expect(autoAdvance('Not now', 'replied')).toBe('Replied')
    expect(autoAdvance('Custom', 'replied')).toBeNull()
  })
})

describe('conversions', () => {
  it('is reached(i) / reached(i-1) along the main line', () => {
    const c = conversions(DEFAULT_STAGES, { Contacted: 6, Replied: 2, Interested: 1, 'Meeting booked': 1, Bounced: 2 })
    // total 12 reached Contacted; 4 reached Replied+; 2 Interested+; 1 Meeting+; 0 Won
    expect(c.Contacted).toBeNull()
    expect(c.Replied).toBe(33)
    expect(c.Interested).toBe(50)
    expect(c['Meeting booked']).toBe(50)
    expect(c.Won).toBe(0)
    expect(c.Lost).toBeNull()
    expect(c.Bounced).toBeNull()
  })
  it('null when the previous stage is empty', () => {
    expect(conversions(DEFAULT_STAGES, {}).Replied).toBeNull()
  })
})
