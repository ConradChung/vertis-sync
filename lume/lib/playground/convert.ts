import type { Diagram, DiagramDetails, DiagramNode } from '@/lib/agent/diagram'
import { DETAILS_MAX_CHARS, DIAGRAM_MAX_NODES } from '@/lib/agent/diagram'
import type { Skill, SkillStep } from '@/lib/agent/skillModel'
import { STEP_LABEL } from '@/lib/agent/skillModel'
import type { CampaignFlowResponse, FlowFeeder, FlowStage, StageId } from '@/lib/campaigns/types'

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

type DataRow = NonNullable<DiagramDetails['data']>[number]
const row = (label: string, value: string | number | null | undefined, source?: string): DataRow | null =>
  value === null || value === undefined || value === '' ? null : { label, value: typeof value === 'number' ? fmt.format(value) : clip(value, 200), ...(source ? { source } : {}) }

/** Drop empty fields, keep within the per-node budget (trim the longest lists first). */
export function compactDetails(d: DiagramDetails): DiagramDetails | undefined {
  const out = Object.fromEntries(
    Object.entries(d).filter(([, v]) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== ''))
  ) as DiagramDetails
  if (!Object.keys(out).length) return undefined
  const lists = ['data', 'how', 'risks', 'links', 'inputs', 'outputs'] as const
  while (JSON.stringify(out).length > DETAILS_MAX_CHARS) {
    const k = lists.find((l) => (out[l]?.length ?? 0) > 1)
    if (!k) {
      if (out.why) out.why = clip(out.why, Math.max(80, out.why.length - 200))
      else break
      continue
    }
    ;(out[k] as unknown[]).pop()
  }
  return out
}

const pct = (n: number | null, d: number | null) => (n !== null && d ? `${((n / d) * 100).toFixed(1)}%` : null)

/** Why each Flow stage exists (same wording as the Flow view's tooltips, plus the role in the pipeline). */
const STAGE_WHY: Record<StageId, string> = {
  import: 'Leads enter Lume here: a CSV, an Apollo/Leadsfriday order or an Apify dataset becomes a validation job.',
  validate: 'The email finder and validator keep only deliverable addresses, so the campaign does not burn inbox reputation on bounces.',
  enrich: 'Operating-city enrichment fills {{city}} so copy can be local; leads with no city go to the No Location campaign.',
  push: 'The push gate is where Conrad picks the Instantly campaign and approves sending the validated leads into it.',
  send: 'Instantly sends the sequence from the campaign inboxes on its schedule; every step counts, so emails sent can exceed leads.',
  reply: 'Replies land in the Instantly unibox and the Lume CRM; interested ones become deals.',
  bank: 'The lead bank holds validated leads queued for this campaign; rotation moves them into Instantly in batches.',
}

const STAGE_TOOLS: Partial<Record<StageId, string[]>> = {
  import: ['Import tab', 'import_actor_run'],
  validate: ['decide_validation'],
  enrich: ['ingest gate (approve + enrich)'],
  push: ['push gate', 'assign_leads'],
  send: ['Instantly', 'pause_campaign', 'resume_campaign'],
  reply: ['Instantly unibox', 'CRM', 'draft_reply'],
  bank: ['lead_bank', 'Rotate tab'],
}

function stageDetails(s: FlowStage, flow: CampaignFlowResponse): DiagramDetails | undefined {
  // Partial responses (older payloads, fixtures) still convert; missing numbers are just omitted.
  const c: Partial<CampaignFlowResponse['counts']> = flow.counts ?? {}
  const data: (DataRow | null)[] = [row(s.label, s.count), row('Source', s.source)]
  if (s.id === 'send') data.push(row('Status', flow.campaign_status), row('Leads in campaign', c.in_campaign), row('Rotated into Instantly', c.rotated))
  if (s.id === 'reply') data.push(row('Reply rate', pct(c.replies ?? null, c.sent ?? null)), row('Emails sent', c.sent))
  if (s.id === 'bank') data.push(row('Total in bank', c.bank_total), row('Still queued', c.bank_queued), row('Breakdown', s.hint))
  if (s.id === 'import' || s.id === 'validate' || s.id === 'enrich' || s.id === 'push')
    data.push(row('Validation jobs', flow.jobs?.length), row('Open gates', flow.gates?.length))
  const unused = s.status === 'unused'
  const links: NonNullable<DiagramDetails['links']> = []
  if (s.action?.type === 'link') links.push({ label: s.action.label, url: s.action.href })
  if (s.id === 'send') links.push({ label: 'Open Campaigns', url: '/campaigns' })
  if (s.id === 'reply') links.push({ label: 'Open this campaign in the CRM', url: `/crm?campaign=${encodeURIComponent(flow.campaign_id)}` })
  if (s.id === 'bank') links.push({ label: 'Open Rotate', url: '/rotate' })
  return compactDetails({
    why: unused ? `Not used for this campaign: ${s.hint ?? 'leads arrive another way'}. ${STAGE_WHY[s.id]}` : STAGE_WHY[s.id],
    tools: STAGE_TOOLS[s.id],
    data: data.filter((d): d is DataRow => d !== null),
    owner: s.id === 'push' ? 'Conrad tap' : s.id === 'send' || s.id === 'bank' ? 'Lume' : undefined,
    approval: s.id === 'push' || s.id === 'validate' ? true : undefined,
    risks:
      s.id === 'send' && (c.sent ?? 0) > 0 && (c.replies ?? 0) / (c.sent || 1) < 0.005
        ? ['Reply rate under 0.5%: check copy, targeting and deliverability before adding more leads.']
        : undefined,
    links,
  })
}

function feederDetails(f: FlowFeeder): DiagramDetails | undefined {
  return compactDetails({
    why:
      f.kind === 'system'
        ? 'The instantly-rotate pg_cron jobs top the campaign up from the lead bank on a schedule, so it never runs dry.'
        : 'A Lume rotation rule moves matching lead-bank leads into this campaign on its schedule.',
    how: [f.schedule, f.active ? 'Active' : 'Inactive — it will not run until activated'],
    tools: [f.kind === 'system' ? 'pg_cron' : 'rotation rule', 'lead_bank'],
    data: [
      row('Schedule', f.schedule),
      row('Cron', f.cron.join(' · ')),
      row('Next run', f.next_run),
      row('Last run', f.last_run),
      row('Last result', f.last_result),
      row('Leads added', f.leads_added_label || f.leads_added),
    ].filter((d): d is DataRow => d !== null),
    owner: 'Lume',
    approval: false,
    links: [{ label: f.kind === 'system' ? 'Open Rotate' : 'Open this rule', url: f.href }],
  })
}

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
    details: stageDetails(s, flow),
  }))
  const edges: Diagram['edges'] = []
  for (let i = 1; i < flow.stages.length; i++) edges.push({ from: flow.stages[i - 1].id, to: flow.stages[i].id })

  const joinId = flow.stages.find((s) => s.id === 'send')?.id ?? flow.stages.at(-1)?.id
  const bankUsed = flow.bank && (flow.bank.count ?? 0) > 0
  if (bankUsed && joinId) {
    nodes.push({
      id: 'bank',
      label: clip(flow.bank.label, 60),
      detail: stageDetail(flow.bank),
      kind: 'source',
      state: STATE[flow.bank.status],
      details: stageDetails(flow.bank, flow),
    })
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
        details: feederDetails(f),
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

const SKILL_TOOLS: Record<SkillStep['type'], string[]> = {
  apify_actor: ['get_actor_input_schema', 'run_apify_actor'],
  import: ['load_actor_results', 'import_actor_run'],
  validate: ['get_validation_queue', 'decide_validation'],
  duplicate_campaign: ['duplicate_campaign', 'update_campaign_sequence'],
  assign_leads: ['assign_leads'],
  rotation_rule: ['create_rotation_rule', 'activate_rule'],
  launch: ['activate_campaign'],
  note: [],
}
const SKILL_APPROVAL: Record<SkillStep['type'], boolean | undefined> = {
  apify_actor: true,
  import: true,
  validate: true,
  duplicate_campaign: true,
  assign_leads: true,
  rotation_rule: true,
  launch: true,
  note: undefined,
}
const SKILL_WHY: Record<SkillStep['type'], string> = {
  apify_actor: 'Scrape the lead source with a capped Apify run; Conrad confirms every input first.',
  import: 'Stage the results at the ingest gate so nothing reaches a campaign unreviewed.',
  validate: 'Find and validate emails, then apply the company and location barriers; only valid emails go forward.',
  duplicate_campaign: 'Create the campaign by copying settings (inboxes, schedule, limits) from an existing one, then add the new copy.',
  assign_leads: 'Move the validated leads into the campaign.',
  rotation_rule: 'Keep the campaign topped up from the lead bank on a schedule.',
  launch: 'Start sending once copy and leads are in place.',
  note: '',
}

const placeholders = (v: unknown): string[] => [...new Set([...JSON.stringify(v ?? '').matchAll(/\{\{\s*([A-Za-z][\w]*)\s*\}\}/g)].map((m) => `{{${m[1]}}}`))]

function skillDetails(s: SkillStep, vars: Skill['variables']): DiagramDetails | undefined {
  const used = placeholders(s)
  const varRows = vars
    .filter((v) => used.includes(`{{${v.name}}}`))
    .map((v) => row(`{{${v.name}}}`, [v.description, v.default ? `default: ${v.default}` : null].filter(Boolean).join(' · ') || 'asked at run time'))
  const base: DiagramDetails = {
    why: s.type === 'note' ? s.text : [SKILL_WHY[s.type], 'note' in s && s.note ? s.note : null].filter(Boolean).join(' '),
    tools: SKILL_TOOLS[s.type],
    approval: SKILL_APPROVAL[s.type],
    owner: s.type === 'note' ? undefined : 'Conrad tap',
    inputs: used.length ? used : undefined,
  }
  switch (s.type) {
    case 'apify_actor':
      return compactDetails({
        ...base,
        actors: [
          {
            id: s.actor_id,
            ...(s.actor_name ? { name: clip(s.actor_name, 120) } : {}),
            ...(s.budget_usd ? { price: `≤ $${s.budget_usd} per run` } : {}),
            url: `https://apify.com/${s.actor_id.replace('~', '/')}`,
          },
        ],
        cost: s.budget_usd ? `≤ $${s.budget_usd}` : 'capped at $20',
        data: [
          ...Object.entries(s.input_template ?? {})
            .slice(0, 10)
            .map(([k, v]) => row(k, clip(typeof v === 'string' ? v : JSON.stringify(v), 200))),
          ...varRows,
        ].filter((d): d is DataRow => d !== null),
        decision: ['Confirm the actor inputs when the skill runs (saved values are suggestions).'],
      })
    case 'duplicate_campaign':
      return compactDetails({
        ...base,
        data: [row('Copy settings from', s.source_campaign_name ?? s.source_campaign_id), row('New name', s.name_template), ...varRows].filter(
          (d): d is DataRow => d !== null
        ),
      })
    case 'assign_leads':
      return compactDetails({
        ...base,
        data: [row('Leads', s.count ?? null), ...Object.entries(s.filter ?? {}).slice(0, 8).map(([k, v]) => row(k, JSON.stringify(v))), ...varRows].filter(
          (d): d is DataRow => d !== null
        ),
      })
    case 'rotation_rule':
      return compactDetails({
        ...base,
        data: Object.entries(s.rule)
          .slice(0, 10)
          .map(([k, v]) => row(k, typeof v === 'string' ? v : JSON.stringify(v)))
          .filter((d): d is DataRow => d !== null),
      })
    default:
      return compactDetails({ ...base, data: varRows.filter((d): d is DataRow => d !== null) })
  }
}

/** A skill's steps as a straight planned pipeline (notes included, in order). */
export function skillToDiagram(skill: Pick<Skill, 'name' | 'steps'> & Partial<Pick<Skill, 'variables'>>): Diagram {
  const steps = skill.steps.slice(0, DIAGRAM_MAX_NODES)
  const nodes: DiagramNode[] = steps.map((s, i) => {
    const detail = skillDetail(s)
    return {
      id: `s${i + 1}`,
      label: clip(s.type === 'note' ? `Note ${i + 1}` : STEP_LABEL[s.type], 60),
      ...(detail ? { detail: clip(detail, 160) } : {}),
      kind: SKILL_KIND[s.type],
      state: 'planned',
      details: skillDetails(s, skill.variables ?? []),
    }
  })
  const edges = nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id }))
  return { title: skill.name, nodes, edges }
}
