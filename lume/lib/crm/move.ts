import 'server-only'
import { createAction, DuplicateActionError } from '@/lib/actions/create'
import { planStageMove } from '@/lib/crm/stages'
import { getStages, setStage } from '@/lib/crm/service'
import type { CrmDeal } from '@/lib/crm/types'

export type MoveOutcome =
  | { ok: true; applied: true }
  | { ok: true; applied: false; pending_action_id: string }
  | { ok: false; status: number; error: string }

/**
 * A stage move asked for by the owner (board drag, table, sheet). Won/Lost go
 * through the Approve/Deny gate as `crm_close_deal` (never applied here);
 * other moves are direct and logged as a `stage_changed` activity, source user.
 */
export async function moveDeal(deal: CrmDeal, to: string, reason: string | null | undefined): Promise<MoveOutcome> {
  const stages = await getStages(deal.campaign_id)
  const plan = planStageMove(deal.stage, to, reason, stages)
  switch (plan.type) {
    case 'error':
      return { ok: false, status: 400, error: plan.error }
    case 'noop':
      return { ok: true, applied: true }
    case 'direct': {
      const from = await setStage(deal.id, plan.to, 'user')
      return from === null ? { ok: false, status: 404, error: 'not_found' } : { ok: true, applied: true }
    }
    case 'approval':
      try {
        const action = await createAction(
          'crm_close_deal',
          {
            deal_id: deal.id,
            stage: plan.to,
            reason: plan.reason,
            campaign_id: deal.campaign_id,
            lead_email: deal.email,
            ...(deal.name ? { lead_name: deal.name } : {}),
            summary: '',
          },
          'user'
        )
        return { ok: true, applied: false, pending_action_id: action.id }
      } catch (err) {
        if (err instanceof DuplicateActionError) return { ok: false, status: 409, error: 'close_awaiting' }
        throw err
      }
  }
}
