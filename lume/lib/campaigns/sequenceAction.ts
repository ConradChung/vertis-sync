import 'server-only'
import { z } from 'zod'
import { getSequenceFresh } from '@/lib/adapters/instantlySequences'
import { isInstantlyConfigured } from '@/lib/adapters/instantly'
import {
  diffSequences,
  diffSummary,
  editStepsSchema,
  sequenceProblems,
  toEditSteps,
  toInstantlySteps,
  type EditStep,
  type InstantlyStep,
} from '@/lib/campaigns/sequence'
import type { Json } from '@/lib/db/types'
import { formatViolation, type SopViolation } from '@/lib/copy/sopLint'
import { sopGate, type SopGate } from '@/lib/copy/sopGate'
import { CAMPAIGN_ID_RE } from '@/lib/rules/schema'

/**
 * `update_sequence` snapshot builder (POST /api/actions and the agent's
 * `update_campaign_sequence`). Reads the campaign's sequence fresh from
 * Instantly, refuses when it no longer matches the hash the editor loaded
 * (`base_hash`), validates the edit, and freezes what will be PATCHed
 * (`steps`, Instantly shape) with the hash it replaces (`before_hash`) and a
 * plain-text before/after for the approval diff. The executor re-reads and
 * compares `before_hash` again before writing.
 *
 * SOP gate: the new sequence is linted against the cold-email SOP (base +
 * the client overlay matching the campaign, `lib/copy/sopGate.ts`). Any
 * blocking violation refuses the edit (422 `sop_violations`, one problem line
 * per violation naming rule, step and variant, plus the structured
 * `violations`), so the agent fixes the copy; a malformed SOP refuses it too
 * (500 `sop_invalid`). Warnings ride along as `sop_warnings`.
 *
 * Payload: { campaign_id, campaign_name, before_hash, steps, before, after, summary, sop_client, sop_warnings }
 */

export const UpdateSequenceRequest = z.object({
  campaign_id: z.string().regex(CAMPAIGN_ID_RE),
  steps: editStepsSchema,
  /** The hash the editor loaded; omitted by the agent (it edits what is live now). */
  base_hash: z.string().regex(/^[0-9a-f]{32}$/).optional(),
})
export type UpdateSequenceInput = z.infer<typeof UpdateSequenceRequest>

export type SequenceBuild =
  | { ok: true; payload: Record<string, Json> & { summary: string } }
  | { ok: false; status: number; error: string; problems?: string[]; violations?: SopViolation[] }

/** Lint with the SOP; a malformed SOP is an error, never a skipped lint. */
export function runSopGate(campaign: { id: string; name: string | null }, steps: EditStep[]): { ok: true; gate: SopGate } | { ok: false; status: number; error: string; problems: string[]; violations?: SopViolation[] } {
  let gate: SopGate
  try {
    gate = sopGate(campaign, steps)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[campaigns/sequence] SOP load failed:', message)
    return { ok: false, status: 500, error: 'sop_invalid', problems: [message] }
  }
  if (gate.blocking.length) {
    return { ok: false, status: 422, error: 'sop_violations', problems: [...gate.blocking, ...gate.warnings].map(formatViolation), violations: [...gate.blocking, ...gate.warnings] }
  }
  return { ok: true, gate }
}

const stripRefs = (steps: EditStep[]): EditStep[] =>
  steps.map((st) => ({
    delay: st.delay,
    delay_unit: st.delay_unit,
    variants: st.variants.map((v) => ({ subject: v.subject.trim(), body: v.body.trim(), ...(v.disabled ? { disabled: true } : {}) })),
  }))

export async function buildUpdateSequence(raw: unknown, campaignName: (id: string) => Promise<string>): Promise<SequenceBuild> {
  const parsed = UpdateSequenceRequest.safeParse(raw)
  if (!parsed.success) return { ok: false, status: 400, error: 'invalid_payload' }
  const input = parsed.data
  if (!isInstantlyConfigured()) return { ok: false, status: 503, error: 'instantly_not_configured' }
  const problems = sequenceProblems(input.steps)
  if (problems.length) return { ok: false, status: 400, error: 'invalid_sequence', problems }

  let current
  try {
    current = await getSequenceFresh(input.campaign_id)
  } catch (err) {
    console.error('[campaigns/sequence] read failed:', err instanceof Error ? err.message : err)
    return { ok: false, status: 502, error: 'instantly_unreachable' }
  }
  if (input.base_hash && input.base_hash !== current.hash) return { ok: false, status: 409, error: 'sequence_changed' }

  const before = stripRefs(toEditSteps(current.steps))
  const after = stripRefs(input.steps)
  const diff = diffSequences(before, after)
  if (!diff.length) return { ok: false, status: 400, error: 'no_changes' }

  const name = current.name ?? (await campaignName(input.campaign_id))
  const sop = runSopGate({ id: input.campaign_id, name }, input.steps)
  if (!sop.ok) return sop
  const steps = toInstantlySteps(input.steps, current.steps)
  return {
    ok: true,
    payload: {
      campaign_id: input.campaign_id,
      campaign_name: name,
      before_hash: current.hash,
      steps: steps as unknown as Json,
      before: before as unknown as Json,
      after: after as unknown as Json,
      summary: `Update the email sequence of ${name}: ${diffSummary(diff)} (${after.length} step${after.length === 1 ? '' : 's'} after)`,
      sop_client: sop.gate.client,
      sop_warnings: sop.gate.warnings.map(formatViolation),
    },
  }
}

/** The steps a payload will write (Instantly HTML), as plain text for the SOP lint. */
export const payloadLintSteps = (p: Record<string, Json>): EditStep[] => toEditSteps(p.steps as unknown as InstantlyStep[])

/** What `createAction` requires of an `update_sequence` payload, SOP lint included. */
export function updateSequencePayloadError(p: Record<string, Json>): string | null {
  if (typeof p.campaign_id !== 'string' || !CAMPAIGN_ID_RE.test(p.campaign_id)) return 'payload.campaign_id is required'
  if (typeof p.before_hash !== 'string' || !/^[0-9a-f]{32}$/.test(p.before_hash)) return 'payload.before_hash is required'
  if (!Array.isArray(p.steps) || !p.steps.length) return 'payload.steps must be a non-empty array'
  if (!Array.isArray(p.before) || !Array.isArray(p.after)) return 'payload.before/after are required'
  const name = typeof p.campaign_name === 'string' ? p.campaign_name : null
  const sop = runSopGate({ id: p.campaign_id, name }, payloadLintSteps(p))
  if (!sop.ok) return `${sop.error}: ${sop.problems.join(' | ')}`
  return null
}
