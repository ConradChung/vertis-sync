// Live ETA for a validation job, measured while it runs (pure). telegram-inbox's
// quoteEta writes the first estimate at decision time from fixed per-row
// constants; email-validator and operating-city-enricher overwrite it after
// each batch with what this invocation actually achieves, split by stage so
// Lume can say "Validating · ~1 h 30 min left, then enrichment ~2 h".

/** Enrichment with 2 workers on a shared 1 s pacer (Perplexity + Haiku ~4-5 s each): ~2.5 s per row. */
export const ENRICH_SECONDS_PER_ROW = 2.5
/** instantly-push: 0.25 s pacing + the lead create (same as telegram-inbox's estimate). */
export const PUSH_SECONDS_PER_ROW = 0.55
/** The workspace's average valid rate, until this job has decided enough rows of its own. */
export const VALID_RATE_FALLBACK = 0.48
const MIN_ROWS = 10

/** Rows per second this invocation achieved; null until there is enough to measure. */
export function measuredRate(rows: number, elapsedMs: number): number | null {
  if (rows < MIN_ROWS || elapsedMs <= 0) return null
  return rows / (elapsedMs / 1000)
}

export interface LiveEta {
  eta_stage: 'validating' | 'enriching'
  eta_seconds: number
  eta_validate_seconds: number
  eta_enrich_seconds: number | null
}

/**
 * While validating: the remaining rows at the measured rate, then (when the
 * job enriches) the valid rows expected — those found so far plus the
 * observed valid rate of what is left — at ENRICH_SECONDS_PER_ROW, then the
 * push of those valid rows.
 */
export function validatingEta(i: { remaining: number; ratePerSec: number; enrich: boolean; valid: number; decided: number }): LiveEta {
  const validateS = Math.max(0, i.remaining) / i.ratePerSec
  const validRate = i.decided >= MIN_ROWS ? i.valid / i.decided : VALID_RATE_FALLBACK
  const expectedValid = i.valid + validRate * Math.max(0, i.remaining)
  const enrichS = i.enrich ? expectedValid * ENRICH_SECONDS_PER_ROW : 0
  const pushS = expectedValid * PUSH_SECONDS_PER_ROW
  return {
    eta_stage: 'validating',
    eta_validate_seconds: Math.round(validateS),
    eta_enrich_seconds: i.enrich ? Math.round(enrichS) : null,
    eta_seconds: Math.round(validateS + enrichS + pushS),
  }
}

/** While enriching: the remaining enrichment rows at the measured rate, then the push of every valid row. */
export function enrichingEta(i: { remaining: number; ratePerSec: number; validTotal: number }): LiveEta {
  const enrichS = Math.max(0, i.remaining) / i.ratePerSec
  return {
    eta_stage: 'enriching',
    eta_validate_seconds: 0,
    eta_enrich_seconds: Math.round(enrichS),
    eta_seconds: Math.round(enrichS + i.validTotal * PUSH_SECONDS_PER_ROW),
  }
}
