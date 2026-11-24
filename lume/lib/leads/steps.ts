/**
 * The five sheet steps every lead moves through (GTM-18), numbered the same
 * way everywhere: the Lume page eyebrows, the nav, a lead's status column in
 * Lume and in the client portal. `stepLabel` mirrors the SQL
 * `lume_step_label()` (supabase/migrations/*_lume_pipeline_steps.sql) so the
 * "# · name" text reads the same from either side; tests pin both.
 *
 * A lead's status is the furthest step it reached. A lead that drops out
 * keeps that step plus a reason: "3 · Filtered — excluded: vendor".
 */

export const PIPELINE_STEPS = [
  { step: 1, key: 'imported', name: 'Imported', page: 'Import & Orders', href: '/import' },
  { step: 2, key: 'combined', name: 'Combined', page: 'Lead lists', href: '/import/leads' },
  { step: 3, key: 'filtered', name: 'Filtered', page: 'Lead lists → Final', href: '/import/leads' },
  { step: 4, key: 'validated', name: 'Validated', page: 'Progress', href: '/progress' },
  { step: 5, key: 'in_campaign', name: 'In campaign', page: 'Campaigns', href: '/campaigns' },
] as const

export type PipelineStep = (typeof PIPELINE_STEPS)[number]['step']
export type StepKey = (typeof PIPELINE_STEPS)[number]['key']

export const FIRST_STEP: PipelineStep = 1
export const LAST_STEP: PipelineStep = 5

/** A step number from anything (a DB smallint, a string, null); unknown or out of range → 1 (every stored row starts imported). */
export function toStep(v: unknown): PipelineStep {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isInteger(n) && n >= FIRST_STEP && n <= LAST_STEP ? (n as PipelineStep) : FIRST_STEP
}

export const stepName = (step: unknown): string => PIPELINE_STEPS[toStep(step) - 1].name

/** "3 · Filtered", or "3 · Filtered — excluded: vendor" with a note. */
export function stepLabel(step: unknown, note?: string | null): string {
  const s = toStep(step)
  const base = `${s} · ${PIPELINE_STEPS[s - 1].name}`
  const n = note?.replace(/\s+/g, ' ').trim()
  return n ? `${base} — ${n}` : base
}

/** The eyebrow a page shows for the step(s) it handles: "Step 1 · Imported", "Steps 2–3 · Combined → Filtered". */
export function stepEyebrow(...steps: PipelineStep[]): string {
  const sorted = [...new Set(steps)].sort((a, b) => a - b)
  if (sorted.length === 0) return ''
  if (sorted.length === 1) return `Step ${sorted[0]} · ${stepName(sorted[0])}`
  return `Steps ${sorted[0]}–${sorted[sorted.length - 1]} · ${sorted.map(stepName).join(' → ')}`
}

/** The stage a whole sheet (lead list) sits at, as stored on lead_review_sets.sheet_stage. */
export type SheetStage = 'imported' | 'combined' | 'final'

export const STAGE_STEP: Record<SheetStage, PipelineStep> = { imported: 1, combined: 2, final: 3 }

export function toSheetStage(v: unknown): SheetStage {
  return v === 'combined' || v === 'final' ? v : 'imported'
}

/** "2 · Combined master", "3 · Final sheet", "1 · Imported sheet". */
export function sheetStageLabel(stage: unknown): string {
  const s = toSheetStage(stage)
  return `${STAGE_STEP[s]} · ${s === 'imported' ? 'Imported sheet' : s === 'combined' ? 'Combined master' : 'Final sheet'}`
}

/** The furthest of two steps (status never moves backwards). */
export const furthest = (a: unknown, b: unknown): PipelineStep => (Math.max(toStep(a), toStep(b)) as PipelineStep)
