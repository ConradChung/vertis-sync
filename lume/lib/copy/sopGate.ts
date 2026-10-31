import 'server-only'
import { loadSopLibrary, SopError, sopForCampaign } from '@/lib/copy/sop'
import { formatViolation, isBlocking, lintSequence, RENDER_RULES, type LintStep, type SopViolation } from '@/lib/copy/sopLint'

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

const key = (v: SopViolation) => JSON.stringify([v.rule, v.step, v.variant, v.message, v.excerpt])

/**
 * Lint with the full rules (base + overlay), then decide what blocks with
 * `blockingRules`: a violation blocks only when the blocking rules flag it
 * too. While the base SOP is a placeholder its rules are warnings: a campaign
 * no client SOP covers is never refused, and a client campaign is refused
 * only by the client's own rules. The render rules (a retired variable that
 * would send blank, a bare {{jurisdiction}}, "the {{compliance_law}}") block
 * whatever the SOP says.
 */
export function sopGate(campaign: { id?: string | null; name?: string | null }, steps: LintStep[]): SopGate {
  const { rules, client, blocking: strict } = sopForCampaign(campaign, loadSopLibrary())
  const all = lintSequence(steps, rules)
  const strictKeys = new Map<string, number>()
  for (const v of strict ? lintSequence(steps, strict).filter(isBlocking) : []) strictKeys.set(key(v), (strictKeys.get(key(v)) ?? 0) + 1)
  const blocking: SopViolation[] = []
  const warnings: SopViolation[] = []
  for (const v of all) {
    const n = strictKeys.get(key(v)) ?? 0
    if (isBlocking(v) && n > 0) {
      strictKeys.set(key(v), n - 1)
      blocking.push(v)
    } else if (isBlocking(v) && RENDER_RULES.has(v.rule)) {
      blocking.push(v)
    } else warnings.push({ ...v, severity: 'warning' })
  }
  return { client, blocking, warnings }
}

/** "SOP lint (Kaspen SOP) refused this sequence:\n- Step 1, variant A — rule: …" */
export function sopRefusalText(gate: SopGate): string {
  const which = gate.client ? `the ${gate.client} client SOP` : 'the base SOP'
  return [`Blocked by the cold-email SOP (${which}): ${gate.blocking.length} violation${gate.blocking.length === 1 ? '' : 's'}.`, ...gate.blocking.map((v) => `- ${formatViolation(v)}`)].join('\n')
}

export { SopError }
