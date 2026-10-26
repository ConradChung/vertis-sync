import type { GateKind, GateRow } from '@/lib/db/types'
import type { CampaignJob, FlowCounts, FlowStage, StageAction } from '@/lib/campaigns/types'

/**
 * Pure: the six Flow stages for one campaign. Stages never run directly —
 * a stage either links to its open gate on Validate, creates a pending
 * action (pause / resume), or is disabled with the reason.
 */

const VALIDATE_GATES: GateKind[] = ['finder_decision', 'stall']
const PUSH_GATES: GateKind[] = ['campaign_choice', 'push_review']

export function sumCounts(jobs: CampaignJob[], instantly: { sent: number; replies: number } | null): FlowCounts {
  const sum = (k: keyof CampaignJob) => jobs.reduce((n, j) => n + (typeof j[k] === 'number' ? (j[k] as number) : 0), 0)
  return {
    imported: sum('total_rows'),
    validated: sum('valid_count'),
    enriched: sum('enriched_rows'),
    pushed: sum('instantly_pushed'),
    sent: instantly?.sent ?? null,
    replies: instantly?.replies ?? null,
  }
}

const gateLink = (g: GateRow, label: string): StageAction => ({
  type: 'link',
  href: `/validate?gate=${g.kind}:${g.target_id}`,
  label,
})

const NO_GATE = 'No open gate — stages only run through gates.'

export function buildStages(input: {
  counts: FlowCounts
  gates: GateRow[]
  jobs: CampaignJob[]
  campaignStatus: string | null
}): FlowStage[] {
  const { counts, gates, jobs, campaignStatus } = input
  const find = (kinds: GateKind[]) => gates.find((g) => kinds.includes(g.kind)) ?? null
  const validateGate = find(VALIDATE_GATES)
  const pushGate = find(PUSH_GATES)
  const running = jobs.some((j) => j.status === 'processing' || j.status === 'pending')
  const st = (n: number | null): FlowStage['status'] => (n && n > 0 ? 'done' : 'idle')

  let send: StageAction
  if (campaignStatus === 'active') send = { type: 'pending', kind: 'pause_campaign', label: 'Pause' }
  else if (campaignStatus === 'paused') send = { type: 'pending', kind: 'resume_campaign', label: 'Resume' }
  else if (campaignStatus === 'draft')
    send = { type: 'disabled', label: 'Launch', reason: 'Draft campaigns launch from the push gate after leads are pushed.' }
  else send = { type: 'disabled', label: 'Run', reason: campaignStatus ? `Campaign is ${campaignStatus}.` : 'Instantly status unknown.' }

  return [
    {
      id: 'import',
      label: 'Import',
      count: counts.imported,
      status: st(counts.imported),
      hint: `${jobs.length} job${jobs.length === 1 ? '' : 's'}`,
      action: { type: 'link', href: '/import', label: 'Open Import' },
    },
    {
      id: 'validate',
      label: 'Validate',
      count: counts.validated,
      status: validateGate ? 'waiting' : running ? 'active' : st(counts.validated),
      hint: validateGate ? (validateGate.title ?? 'Gate open') : null,
      action: validateGate ? gateLink(validateGate, 'Open gate') : { type: 'disabled', label: 'Run', reason: NO_GATE },
    },
    {
      id: 'enrich',
      label: 'Enrich',
      count: counts.enriched,
      status: st(counts.enriched),
      hint: null,
      action: { type: 'disabled', label: 'Run', reason: 'Enrichment is chosen on the ingest gate (approve + enrich).' },
    },
    {
      id: 'push',
      label: 'Push',
      count: counts.pushed,
      status: pushGate ? 'waiting' : st(counts.pushed),
      hint: pushGate ? (pushGate.title ?? 'Gate open') : null,
      action: pushGate ? gateLink(pushGate, 'Open gate') : { type: 'disabled', label: 'Run', reason: NO_GATE },
    },
    {
      id: 'send',
      label: 'Send',
      count: counts.sent,
      status: campaignStatus === 'active' ? 'active' : st(counts.sent),
      hint: campaignStatus,
      action: send,
    },
    {
      id: 'reply',
      label: 'Reply',
      count: counts.replies,
      status: st(counts.replies),
      hint: null,
      action: { type: 'tab', tab: 'inbox', label: 'Open inbox' },
    },
  ]
}
