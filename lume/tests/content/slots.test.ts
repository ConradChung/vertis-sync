import { describe, expect, it } from 'vitest'
import { callUsd, fitsCap, monthStartIso, parseContentConfig, ptParts } from '@/lib/content/config'
import { inScheduledWindow, isoWeek, parseManualBody, slotForDay, variantFor } from '@/lib/content/slots'

// 2026-12-01 is a Tuesday. 6:30 AM PST = 14:30 UTC; in July (PDT) = 13:30 UTC.
const at = (iso: string) => new Date(iso)

describe('slot rotation', () => {
  it('Tue Proof, Wed Owner view, Thu Hand-raiser, nothing else', () => {
    expect(slotForDay(at('2026-12-01T14:30:00Z'))).toBe('proof')
    expect(slotForDay(at('2026-12-02T14:30:00Z'))).toBe('owner_view')
    expect(slotForDay(at('2026-12-03T14:30:00Z'))).toBe('hand_raiser')
    for (const d of ['2026-11-30', '2026-12-04', '2026-12-05', '2026-12-06']) expect(slotForDay(at(`${d}T14:30:00Z`))).toBeNull()
  })

  it('uses the Pacific day, not UTC (Tue 5 PM PT is Wed in UTC)', () => {
    expect(slotForDay(at('2026-12-02T01:00:00Z'))).toBe('proof')
  })

  it('Hand-raiser alternates breakdown and story week to week', () => {
    const a = variantFor('hand_raiser', at('2026-12-03T14:30:00Z'))
    const b = variantFor('hand_raiser', at('2026-12-10T14:30:00Z'))
    const c = variantFor('hand_raiser', at('2026-12-17T14:30:00Z'))
    expect(new Set([a, b])).toEqual(new Set(['breakdown', 'story']))
    expect(c).toBe(a)
    expect(variantFor('proof', at('2026-12-01T14:30:00Z'))).toBeNull()
    expect(isoWeek('2026-12-03')).toBe(49)
  })

  it('scheduled window is the 6 AM PT hour, across DST', () => {
    expect(inScheduledWindow(at('2026-12-01T14:30:00Z'))).toBe(true) // PST
    expect(inScheduledWindow(at('2026-12-01T13:30:00Z'))).toBe(false) // 5:30 PST
    expect(inScheduledWindow(at('2026-07-07T13:30:00Z'))).toBe(true) // PDT
    expect(inScheduledWindow(at('2026-07-07T14:30:00Z'))).toBe(false) // 7:30 PDT
  })

  it('parses the manual body', () => {
    expect(parseManualBody(null)).toBeNull()
    expect(parseManualBody({ slot: 'proof' })).toBeNull()
    expect(parseManualBody({ force: true })).toEqual({ slot: null, variant: null })
    expect(parseManualBody({ force: true, slot: 'hand_raiser', variant: 'story' })).toEqual({ slot: 'hand_raiser', variant: 'story' })
    expect(parseManualBody({ force: true, slot: 'nope' })).toEqual({ error: expect.stringContaining('slot must be') })
    expect(parseManualBody({ force: true, variant: 'x' })).toEqual({ error: expect.stringContaining('variant') })
  })
})

describe('config', () => {
  it('defaults to dry run, #content-gen, $5 cap; clamps the cap', () => {
    const c = parseContentConfig(null)
    expect(c.dry_run).toBe(true)
    expect(c.slack.channel_name).toBe('content-gen')
    expect(c.monthly_cap_usd).toBe(5)
    expect(parseContentConfig({ dry_run: 'false' }).dry_run).toBe(true)
    expect(parseContentConfig({ dry_run: false }).dry_run).toBe(false)
    expect(parseContentConfig({ monthly_cap_usd: 50 }).monthly_cap_usd).toBe(5)
    expect(parseContentConfig({ monthly_cap_usd: 2 }).monthly_cap_usd).toBe(2)
    expect(parseContentConfig({ slack: { channel_name: '#other', team_id: 'T082MHH6U5P', channel_id: 'bad' } }).slack).toEqual({ channel_name: 'other', team_id: 'T082MHH6U5P', channel_id: null })
  })

  it('spend cap: stops before a call that could cross the cap', () => {
    expect(fitsCap(0, 5)).toBe(true)
    expect(fitsCap(4.75, 5)).toBe(true)
    expect(fitsCap(4.76, 5)).toBe(false)
    expect(fitsCap(5, 5)).toBe(false)
  })

  it('prices calls from usage, cache reads at a tenth', () => {
    expect(callUsd('claude-opus-5-5', { input_tokens: 1_000_000, output_tokens: 0 })).toBe(4)
    expect(callUsd('claude-opus-5-5', { input_tokens: 0, output_tokens: 1_000_000 })).toBe(20)
    expect(callUsd('claude-opus-5-5', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 })).toBe(5.4)
    expect(callUsd('some-new-model', { input_tokens: 1_000_000, output_tokens: 0 })).toBe(10)
  })

  it('PT month start and parts', () => {
    expect(monthStartIso(at('2026-12-01T05:00:00Z'))).toBe('2026-11-01T07:00:00.000Z') // still Nov 30 in PT
    expect(ptParts(at('2026-12-01T14:30:00Z'))).toEqual({ date: '2026-12-01', weekday: 2, hour: 6, minute: 30 })
  })
})
