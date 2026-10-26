import type { CrmStage } from '@/lib/crm/types'

/**
 * Stage rules (pure, client-safe).
 *
 * Main line: Contacted → Replied → Interested → Meeting booked → Won.
 * Side exits: Lost, Bounced, Not now. Moving to Won or Lost is a decision
 * the owner confirms through the Approve/Deny gate (`crm_close_deal`); every
 * other move is direct. Automation (webhooks, Gmail/Muse adapters) only ever
 * moves a deal forward on the main line, or to Bounced, and never to Won/Lost.
 */

export const DEFAULT_STAGES: CrmStage[] = [
  { name: 'Contacted', position: 0, is_terminal: false },
  { name: 'Replied', position: 1, is_terminal: false },
  { name: 'Interested', position: 2, is_terminal: false },
  { name: 'Meeting booked', position: 3, is_terminal: false },
  { name: 'Won', position: 4, is_terminal: true },
  { name: 'Lost', position: 5, is_terminal: true },
  { name: 'Bounced', position: 6, is_terminal: true },
  { name: 'Not now', position: 7, is_terminal: false },
]

export const MAIN_LINE = ['Contacted', 'Replied', 'Interested', 'Meeting booked', 'Won'] as const
export const SIDE_EXITS = ['Lost', 'Bounced', 'Not now'] as const
export const CLOSE_STAGES = ['Won', 'Lost'] as const
export type CloseStage = (typeof CLOSE_STAGES)[number]

/** Won/Lost need an approved `crm_close_deal`; anything else is applied directly. */
export function requiresApproval(stage: string): stage is CloseStage {
  return (CLOSE_STAGES as readonly string[]).includes(stage)
}

export function isKnownStage(stage: string, stages: CrmStage[] = DEFAULT_STAGES): boolean {
  return stages.some((s) => s.name === stage)
}

/** Signals automation can see. */
export type CrmSignal = 'sent' | 'opened' | 'replied' | 'interested' | 'bounced' | 'meeting'

const rank = (stage: string) => (MAIN_LINE as readonly string[]).indexOf(stage)

/**
 * The stage a signal moves a deal to, or null for "leave it". Never Won/Lost;
 * never backwards; a closed deal (Won/Lost/Bounced) is left alone, except
 * that a reply to a Bounced deal is ignored too (it is not ours to reopen).
 * A reply or interest on a "Not now" deal brings it back to the main line.
 */
export function autoAdvance(current: string, signal: CrmSignal): string | null {
  if (current === 'Won' || current === 'Lost' || current === 'Bounced') return null
  if (signal === 'bounced') return 'Bounced'
  const target = signal === 'replied' ? 'Replied' : signal === 'interested' ? 'Interested' : signal === 'meeting' ? 'Meeting booked' : null
  if (!target) return null
  if (current === 'Not now') return target
  const cur = rank(current)
  if (cur === -1) return null // a custom stage: automation does not guess
  return rank(target) > cur ? target : null
}

/** Order stages for columns: main line by position, side exits last. */
export function orderedStages(stages: CrmStage[]): CrmStage[] {
  return [...stages].sort((a, b) => a.position - b.position)
}

/**
 * Conversion into each main-line stage from the previous one: deals that
 * reached stage i (are at i or beyond on the main line) over those that
 * reached i-1. Side-exit deals count as having reached Contacted only.
 * `null` for the first stage, side exits, or an empty previous stage.
 */
export function conversions(stages: CrmStage[], counts: Record<string, number>): Record<string, number | null> {
  const line = orderedStages(stages).filter((s) => rank(s.name) !== -1).map((s) => s.name)
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  const reached = (i: number) =>
    i === 0 ? total : line.slice(i).reduce((n, name) => n + (counts[name] ?? 0), 0)
  const out: Record<string, number | null> = {}
  for (const s of stages) out[s.name] = null
  line.forEach((name, i) => {
    if (i === 0) return
    const prev = reached(i - 1)
    out[name] = prev > 0 ? Math.round((reached(i) / prev) * 100) : null
  })
  return out
}

export function countByStage(deals: { stage: string }[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const d of deals) out[d.stage] = (out[d.stage] ?? 0) + 1
  return out
}

export type StageMovePlan =
  | { type: 'noop' }
  | { type: 'direct'; to: string }
  | { type: 'approval'; to: CloseStage; reason: string }
  | { type: 'error'; error: 'unknown_stage' | 'reason_required' }

/**
 * What a user's stage move does: Won/Lost (with a one-line reason) become a
 * `crm_close_deal` pending action; any other known stage is applied directly.
 */
export function planStageMove(from: string, to: string, reason: string | null | undefined, stages: CrmStage[] = DEFAULT_STAGES): StageMovePlan {
  if (!isKnownStage(to, stages)) return { type: 'error', error: 'unknown_stage' }
  if (from === to) return { type: 'noop' }
  if (requiresApproval(to)) {
    const r = (reason ?? '').trim()
    if (!r) return { type: 'error', error: 'reason_required' }
    return { type: 'approval', to, reason: r.slice(0, 300) }
  }
  return { type: 'direct', to }
}
