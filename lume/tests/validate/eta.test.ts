import { describe, expect, it } from 'vitest'
import { liveEta } from '@/lib/validate/eta'

const T0 = Date.parse('2026-11-06T10:00:00Z')
const at = (s: number) => T0 + s * 1000
const job = (o: Record<string, unknown> = {}) => ({
  status: 'processing',
  eta_seconds: 7200 + 5400,
  eta_updated_at: new Date(T0).toISOString(),
  eta_stage: 'validating' as 'validating' | 'enriching' | null,
  eta_validate_seconds: 5400,
  eta_enrich_seconds: 7200,
  ...o,
})

describe('liveEta', () => {
  it('validating with enrichment: counts the validation part down from eta_updated_at, then names the enrichment', () => {
    expect(liveEta(job(), at(0))).toBe('Validating · ~1 h 30 min left, then enrichment ~2 h')
    expect(liveEta(job(), at(600))).toBe('Validating · ~1 h 20 min left, then enrichment ~2 h')
  })

  it('validating without enrichment: just the remaining total', () => {
    expect(liveEta(job({ eta_enrich_seconds: null, eta_seconds: 5600 }), at(0))).toBe('Validating · ~1 h 33 min left')
  })

  it('validation overran its estimate: says it is finishing, enrichment still named', () => {
    expect(liveEta(job(), at(6000))).toBe('Validating · finishing, then enrichment ~2 h')
  })

  it('enriching: the enrichment part counts down', () => {
    expect(liveEta(job({ eta_stage: 'enriching', eta_validate_seconds: 0, eta_enrich_seconds: 3600, eta_seconds: 3900 }), at(1800))).toBe('Enriching · ~35 min left')
  })

  it('no stage (the decision-time quote) counts the total down and says it is an estimate', () => {
    expect(liveEta(job({ eta_stage: null, eta_validate_seconds: null, eta_enrich_seconds: null, eta_seconds: 3600 }), at(1200))).toBe('~40 min (initial estimate)')
  })

  it('missing stamp: no countdown, the stored number as is', () => {
    expect(liveEta(job({ eta_stage: null, eta_updated_at: null, eta_seconds: 240 }), at(1e6))).toBe('~4 min (initial estimate)')
  })

  it('nothing to show: not running, no eta, or the estimate ran out', () => {
    expect(liveEta(job({ status: 'completed' }), at(0))).toBeNull()
    expect(liveEta(job({ eta_seconds: null, eta_stage: null }), at(0))).toBeNull()
    expect(liveEta(job({ eta_stage: null, eta_seconds: 60 }), at(120))).toBeNull()
  })

  it('a pending job shows its quote too', () => {
    expect(liveEta(job({ status: 'pending', eta_stage: null, eta_seconds: 600 }), at(0))).toBe('~10 min (initial estimate)')
  })
})
