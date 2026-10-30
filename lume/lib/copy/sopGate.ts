import 'server-only'
import { loadSopLibrary, SopError, sopForCampaign } from '@/lib/copy/sop'
import { formatViolation, isBlocking, lintSequence, type LintStep, type SopViolation } from '@/lib/copy/sopLint'

/**
 * The SOP gate on `update_sequence`: lint a whole sequence against the base
 * SOP plus the client overlay that matches the target campaign. Called when
 * the approval is built (`buildUpdateSequence`), when it is created
 * (`createAction`) and by the executor right before writing to Instantly,
 * so an edit approved before the SOP changed is still refused.
 *
 * A malformed SOP throws `SopError` out of here; callers refuse the edit
 * (never skip the lint).
 */

export interface SopGate {
  /** The client overlay applied, or null for the base SOP alone. */
  client: string | null
  /** Blocking violations: the edit is refused when any exist. */
  blocking: SopViolation[]
  /** Warnings (e.g. sequence shape): shown, never refuse. */
  warnings: SopViolation[]
}

export function sopGate(campaign: { id?: string | null; name?: string | null }, steps: LintStep[]): SopGate {
  const { rules, client } = sopForCampaign(campaign, loadSopLibrary())
  const all = lintSequence(steps, rules)
  return { client, blocking: all.filter(isBlocking), warnings: all.filter((v) => !isBlocking(v)) }
}

/** "SOP lint (Kaspen SOP) refused this sequence:\n- Step 1, variant A — rule: …" */
export function sopRefusalText(gate: SopGate): string {
  const which = gate.client ? `the ${gate.client} client SOP` : 'the base SOP'
  return [`Blocked by the cold-email SOP (${which}): ${gate.blocking.length} violation${gate.blocking.length === 1 ? '' : 's'}.`, ...gate.blocking.map((v) => `- ${formatViolation(v)}`)].join('\n')
}

export { SopError }
