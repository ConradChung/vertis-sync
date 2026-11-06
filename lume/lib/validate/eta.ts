import { formatEta } from '@/lib/validate/client'

/** The ETA fields `getJobProgress()` returns (see supabase/functions/_shared/eta.ts for who writes them). */
export interface EtaFields {
  status: string | null
  eta_seconds: number | null
  eta_updated_at: string | null
  /** null: telegram-inbox's decision-time quote; otherwise the stage the live estimate was measured in. */
  eta_stage: 'validating' | 'enriching' | null
  eta_validate_seconds: number | null
  eta_enrich_seconds: number | null
}

/**
 * The job's ETA line at `nowMs`, counted down from `eta_updated_at` so it moves
 * between polls: "Validating · ~1 h 30 min left, then enrichment ~2 h",
 * "Enriching · ~35 min left", or "~40 min (initial estimate)". null when the
 * job isn't running or there is nothing honest to show.
 */
export function liveEta(job: EtaFields, nowMs: number): string | null {
  if (job.status !== 'processing' && job.status !== 'pending') return null
  if (job.eta_seconds == null) return null
  const stamp = job.eta_updated_at ? Date.parse(job.eta_updated_at) : NaN
  const elapsed = Number.isFinite(stamp) ? Math.max(0, (nowMs - stamp) / 1000) : 0
  const left = (s: number) => formatEta(s - elapsed)

  if (job.eta_stage === 'validating') {
    const enrich = job.eta_enrich_seconds != null ? formatEta(job.eta_enrich_seconds) : null
    if (!enrich) {
      const total = left(job.eta_seconds)
      return total ? `Validating · ${total} left` : 'Validating · finishing'
    }
    const v = left(job.eta_validate_seconds ?? 0)
    return `Validating · ${v ? `${v} left` : 'finishing'}, then enrichment ${enrich}`
  }
  if (job.eta_stage === 'enriching') {
    const total = left(job.eta_seconds)
    return total ? `Enriching · ${total} left` : 'Enriching · finishing'
  }
  const total = left(job.eta_seconds)
  return total ? `${total} (initial estimate)` : null
}
