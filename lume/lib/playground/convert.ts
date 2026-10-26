import type { Diagram, DiagramNode } from '@/lib/agent/diagram'
import { DIAGRAM_MAX_NODES } from '@/lib/agent/diagram'
import type { Skill, SkillStep } from '@/lib/agent/skillModel'
import { STEP_LABEL } from '@/lib/agent/skillModel'
import type { CampaignFlowResponse, FlowStage, StageId } from '@/lib/campaigns/types'

/**
 * Turn Lume's other pipeline shapes into the Playground's diagram spec:
 * a campaign's Flow view (lit by real status) and a saved skill (all planned).
 */

const fmt = new Intl.NumberFormat('en-US')

const STATE: Record<FlowStage['status'], DiagramNode['state']> = {
  done: 'done',
  active: 'current',
  waiting: 'current',
  idle: 'planned',
  unused: 'skipped',
}

const STAGE_KIND: Record<StageId, DiagramNode['kind']> = {
  import: 'source',
  validate: 'step',
  enrich: 'step',
  push: 'gate',
  send: 'campaign',
  reply: 'step',
  bank: 'source',
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

function stageDetail(s: FlowStage): string | undefined {
  const parts = [s.count === null ? null : fmt.format(s.count), s.hint].filter(Boolean)
  return parts.length ? clip(parts.join(' · '), 160) : undefined
}

/** Main path in order, plus the lead bank → feeders → Emails sent branch. */
export function flowToDiagram(flow: CampaignFlowResponse): Diagram {
  const nodes: DiagramNode[] = flow.stages.map((s) => ({
    id: s.id,
    label: clip(s.label, 60),
    detail: stageDetail(s),
    kind: STAGE_KIND[s.id],
    state: STATE[s.status],
  }))
  const edges: Diagram['edges'] = []
  for (let i = 1; i < flow.stages.length; i++) edges.push({ from: flow.stages[i - 1].id, to: flow.stages[i].id })

  const joinId = flow.stages.find((s) => s.id === 'send')?.id ?? flow.stages.at(-1)?.id
  const bankUsed = flow.bank && (flow.bank.count ?? 0) > 0
  if (bankUsed && joinId) {
    nodes.push({ id: 'bank', label: clip(flow.bank.label, 60), detail: stageDetail(flow.bank), kind: 'source', state: STATE[flow.bank.status] })
    const feeders = flow.feeders.slice(0, DIAGRAM_MAX_NODES - nodes.length)
    if (!feeders.length) edges.push({ from: 'bank', to: joinId })
    for (const f of feeders) {
      const id = `feeder-${f.id}`.slice(0, 60)
      nodes.push({
        id,
        label: clip(f.name, 60),
        detail: clip([f.schedule, f.leads_added_label].filter(Boolean).join(' · '), 160) || undefined,
        kind: 'cron',
        state: f.active ? (f.last_run ? 'done' : 'current') : 'skipped',
      })
      edges.push({ from: 'bank', to: id }, { from: id, to: joinId, label: f.kind === 'system' ? 'rotates' : 'assigns' })
    }
  }
  return { title: flow.campaign_name ?? 'Campaign flow', nodes, edges }
}

const SKILL_KIND: Record<SkillStep['type'], DiagramNode['kind']> = {
  apify_actor: 'source',
  import: 'step',
  validate: 'step',
  duplicate_campaign: 'campaign',
  assign_leads: 'step',
  rotation_rule: 'cron',
  launch: 'gate',
  note: 'note',
}

function skillDetail(s: SkillStep): string | undefined {
  switch (s.type) {
    case 'apify_actor':
      return [s.actor_name ?? s.actor_id, s.budget_usd ? `≤ $${s.budget_usd}` : null].filter(Boolean).join(' · ')
    case 'duplicate_campaign':
      return `${s.source_campaign_name ?? s.source_campaign_id} → ${s.name_template}`
    case 'assign_leads':
      return s.count ? `${fmt.format(s.count)} leads` : s.note
    case 'note':
      return s.text
    default:
      return s.note
  }
}

/** A skill's steps as a straight planned pipeline (notes included, in order). */
export function skillToDiagram(skill: Pick<Skill, 'name' | 'steps'>): Diagram {
  const steps = skill.steps.slice(0, DIAGRAM_MAX_NODES)
  const nodes: DiagramNode[] = steps.map((s, i) => {
    const detail = skillDetail(s)
    return {
      id: `s${i + 1}`,
      label: clip(s.type === 'note' ? `Note ${i + 1}` : STEP_LABEL[s.type], 60),
      ...(detail ? { detail: clip(detail, 160) } : {}),
      kind: SKILL_KIND[s.type],
      state: 'planned',
    }
  })
  const edges = nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id }))
  return { title: skill.name, nodes, edges }
}
