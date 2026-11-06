// Run: deno test _shared/eta_test.ts
import { assertEquals } from 'jsr:@std/assert@1'
import { enrichingEta, ENRICH_SECONDS_PER_ROW, measuredRate, PUSH_SECONDS_PER_ROW, validatingEta } from './eta.ts'

Deno.test('measuredRate: rows / s of this invocation, null until enough rows and time', () => {
  assertEquals(measuredRate(45, 60_000), 0.75)
  assertEquals(measuredRate(3, 60_000), null)
  assertEquals(measuredRate(45, 0), null)
})

Deno.test('validatingEta: remaining / measured rate, then the enrichment and push tails from the observed valid rate', () => {
  // 5,000 left at 0.75 rows/s; 400 valid of 1,000 decided so far -> 40 % -> 2,000 more + 400 found = 2,400 valid.
  const e = validatingEta({ remaining: 5000, ratePerSec: 0.75, enrich: true, valid: 400, decided: 1000 })
  assertEquals(e.eta_stage, 'validating')
  assertEquals(e.eta_validate_seconds, Math.round(5000 / 0.75))
  assertEquals(e.eta_enrich_seconds, Math.round(2400 * ENRICH_SECONDS_PER_ROW))
  assertEquals(e.eta_seconds, Math.round(5000 / 0.75 + 2400 * ENRICH_SECONDS_PER_ROW + 2400 * PUSH_SECONDS_PER_ROW))
})

Deno.test('validatingEta: no enrichment tail when enrich is off; the workspace valid rate before anything is decided', () => {
  const e = validatingEta({ remaining: 100, ratePerSec: 1, enrich: false, valid: 0, decided: 0 })
  assertEquals(e.eta_enrich_seconds, null)
  assertEquals(e.eta_seconds, Math.round(100 + 100 * 0.48 * PUSH_SECONDS_PER_ROW))
})

Deno.test('enrichingEta: remaining enrichment rows / measured rate, plus the push tail', () => {
  const e = enrichingEta({ remaining: 1000, ratePerSec: 0.5, validTotal: 2400 })
  assertEquals(e, { eta_stage: 'enriching', eta_validate_seconds: 0, eta_enrich_seconds: 2000, eta_seconds: Math.round(2000 + 2400 * PUSH_SECONDS_PER_ROW) })
})
