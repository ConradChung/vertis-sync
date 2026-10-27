import type { Operator, Vertical } from '@/lib/operators/types'

/** Pure text for an operator-driven session: the agent's prompt line and the header chip. */

/** The line put ahead of an operator's agent prompt. */
export function operatorPromptLine(op: Pick<Operator, 'is_master'>, vertical: Pick<Vertical, 'name' | 'campaign_ids'> | null): string {
  if (op.is_master || !vertical) {
    return 'You are being operated by the master Grok Bot (operator), which oversees all verticals and can create new ones. It has the owner’s full authority.'
  }
  const campaigns = vertical.campaign_ids.length ? vertical.campaign_ids.join(', ') : 'none'
  return `You are being operated by the ${vertical.name} Grok Bot (operator). Its campaigns: ${campaigns}. It has the owner’s full authority.`
}

/** "Master" or the vertical's name, for the "Operator: …" chip. */
export function operatorChipLabel(op: Pick<Operator, 'is_master' | 'label'>, vertical: Pick<Vertical, 'name'> | null): string {
  if (op.is_master) return 'Master'
  return vertical?.name ?? op.label
}
