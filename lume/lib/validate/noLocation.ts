/**
 * The no-location sibling campaign (owner, 2026-11-09). Instantly rotates A/B
 * variants itself, so a lead with no resolved city can't be kept off a
 * variant that says {{location}}; the only guarantee is a second campaign
 * whose copy never mentions one. instantly-push already routes city-less
 * leads to `validation_jobs.instantly_campaign_id_nolocation` when it is set.
 */

/** A merge tag for the city: {{location}} (what instantly-push sets), with any spacing or case. */
export const LOCATION_TAG = /\{\{\s*location\s*\}\}/i

export const noLocationName = (main: string) => `${main} — No Location`

type Variant = { subject?: string; body?: string } & Record<string, unknown>
type Step = { variants?: Variant[] } & Record<string, unknown>
type Sequence = { steps?: Step[] } & Record<string, unknown>

export type Stripped =
  | { ok: true; sequences: Sequence[]; removed: number; kept: number }
  | { ok: false; reason: 'no_sequence' | 'step_needs_location'; step?: number }

/**
 * The main campaign's copy minus every variant that uses {{location}}.
 * Refused when a step would be left with no variant (that step can't send
 * without a city) or there is no copy at all — then a template is needed.
 */
export function stripLocationVariants(sequences: unknown): Stripped {
  if (!Array.isArray(sequences) || !sequences.length) return { ok: false, reason: 'no_sequence' }
  let removed = 0
  let kept = 0
  const out: Sequence[] = []
  for (const seq of sequences as Sequence[]) {
    const steps = Array.isArray(seq?.steps) ? seq.steps : []
    if (!steps.length) return { ok: false, reason: 'no_sequence' }
    const nextSteps: Step[] = []
    for (const [i, step] of steps.entries()) {
      const variants = Array.isArray(step?.variants) ? step.variants : []
      const clean = variants.filter((v) => !LOCATION_TAG.test(`${v?.subject ?? ''}\n${v?.body ?? ''}`))
      removed += variants.length - clean.length
      kept += clean.length
      if (!clean.length) return { ok: false, reason: 'step_needs_location', step: i + 1 }
      nextSteps.push({ ...step, variants: clean })
    }
    out.push({ ...seq, steps: nextSteps })
  }
  return { ok: true, sequences: out, removed, kept }
}

/** Templates named like a no-location variant sort first. */
export function rankTemplates<T extends { name: string }>(templates: T[]): T[] {
  const nolo = (t: T) => (/no[\s-]*location/i.test(t.name) ? 0 : 1)
  return [...templates].sort((a, b) => nolo(a) - nolo(b) || a.name.localeCompare(b.name))
}
