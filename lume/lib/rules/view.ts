import type { LumeCampaignRow, PendingActionRow, RotationRuleRow } from '@/lib/db/types'

/** A rule as the Rules table shows it. */
export interface RuleView extends RotationRuleRow {
  campaign_name: string | null
  awaiting: { id: string; kind: PendingActionRow['kind']; created_at: string }[]
}

export function withRuleMeta(
  rules: RotationRuleRow[],
  actions: Pick<PendingActionRow, 'id' | 'kind' | 'rule_id' | 'created_at'>[],
  campaigns: Pick<LumeCampaignRow, 'external_id' | 'name'>[]
): RuleView[] {
  const names = new Map(campaigns.filter((c) => c.external_id).map((c) => [c.external_id as string, c.name]))
  return rules.map((r) => ({
    ...r,
    campaign_name: names.get(r.campaign_id) ?? null,
    awaiting: actions.filter((a) => a.rule_id === r.id).map(({ id, kind, created_at }) => ({ id, kind, created_at })),
  }))
}
