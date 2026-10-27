import { describe, expect, it } from 'vitest'
import { dragLabel, errorText, lastResultLabel, toRuleFilter } from '@/lib/rules/client'

describe('toRuleFilter', () => {
  it('maps origin → source and drops blanks', () => {
    expect(toRuleFilter({ origin: 'lead_bank', city: ' Austin ', icp_status: '' })).toEqual({ source: 'lead_bank', city: 'Austin' })
    expect(toRuleFilter({ origin: 'bogus' })).toEqual({})
  })
})

describe('dragLabel', () => {
  it('names what moves', () => {
    expect(dragLabel({ type: 'leads', refs: [{ origin: 'validation_rows', id: '1' }] })).toBe('1 lead')
    expect(dragLabel({ type: 'filter', filter: {}, total: 1204 })).toBe('all 1,204 matching')
  })
})

describe('errorText', () => {
  it('maps codes and network failures', () => {
    expect(errorText({ status: 409, body: { error: 'duplicate' } })).toMatch(/Already waiting/)
    expect(errorText({ status: 0, body: null })).toMatch(/nothing was sent/)
    expect(errorText({ status: 500, body: { error: 'database' } })).toBe('Request failed (500).')
  })
})

describe('lastResultLabel', () => {
  it('reads every outcome', () => {
    expect(lastResultLabel(null).text).toBe('Never run')
    expect(lastResultLabel({ error: 'boom' })).toEqual({ text: 'Error: boom', tone: 'warn' })
    expect(lastResultLabel({ count: 0, skipped: 'no_candidates' }).text).toBe('No candidates')
    expect(lastResultLabel({ skipped: 'action_awaiting' }).text).toMatch(/still open/)
    expect(lastResultLabel({ count: 40, action_id: 'a' })).toEqual({ text: '40 leads awaiting confirmation', tone: 'ok' })
    expect(lastResultLabel({ count: 12, action_id: 'a', removal: true })).toEqual({ text: '12 leads to remove, awaiting confirmation', tone: 'ok' })
  })
})
