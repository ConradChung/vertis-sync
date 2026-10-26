import { describe, expect, it } from 'vitest'
import { diagramSchema } from '@/lib/agent/diagram'
import { flowToDiagram, skillToDiagram } from '@/lib/playground/convert'
import type { CampaignFlowResponse, FlowStage } from '@/lib/campaigns/types'

const stage = (id: FlowStage['id'], label: string, status: FlowStage['status'], count: number | null, hint: string | null = null): FlowStage => ({
  id,
  label,
  status,
  count,
  hint,
  source: '',
  action: { type: 'disabled', label: 'Run', reason: '' },
})

const flow = {
  campaign_id: 'c1',
  instantly: 'ok',
  campaign_status: 'paused',
  campaign_name: 'Scaleport - Fall Mega',
  counts: {} as CampaignFlowResponse['counts'],
  jobs: [],
  gates: [],
  stages: [
    stage('import', 'Import', 'unused', 0, 'Not used: fed by the lead bank'),
    stage('validate', 'Validate', 'unused', 0),
    stage('enrich', 'Enrich', 'unused', 0),
    stage('push', 'Push', 'unused', 0),
    stage('send', 'Emails sent', 'done', 1266, 'paused'),
    stage('reply', 'Replies', 'done', 4, '0.3% of emails'),
  ],
  bank: stage('bank', 'Lead bank', 'done', 2212, '993 queued'),
  feeders: [
    {
      id: 'system',
      kind: 'system',
      name: 'Auto-rotation',
      schedule: 'Daily at 6:00 AM and 6:00 PM',
      cron: [],
      active: true,
      next_run: null,
      last_run: '2026-10-25T18:00:00Z',
      last_result: '',
      leads_added: 1101,
      leads_added_label: '1,101 added over 35 runs',
      href: '/rotate',
    },
  ],
} as CampaignFlowResponse

describe('flowToDiagram', () => {
  it('maps stages, lit states and the lead-bank → feeder → send branch', () => {
    const d = flowToDiagram(flow)
    expect(diagramSchema.safeParse(d).success).toBe(true)
    expect(d.title).toBe('Scaleport - Fall Mega')
    const n = Object.fromEntries(d.nodes.map((x) => [x.id, x]))
    expect(n.import.state).toBe('skipped')
    expect(n.send).toMatchObject({ state: 'done', kind: 'campaign', detail: '1,266 · paused' })
    expect(n['feeder-system']).toMatchObject({ kind: 'cron', state: 'done', label: 'Auto-rotation' })
    expect(d.edges).toContainEqual({ from: 'bank', to: 'feeder-system' })
    expect(d.edges).toContainEqual({ from: 'feeder-system', to: 'send', label: 'rotates' })
    expect(d.edges).toContainEqual({ from: 'push', to: 'send' })
  })

  it('links the bank straight to send when nothing feeds it, and skips an empty bank', () => {
    expect(flowToDiagram({ ...flow, feeders: [] }).edges).toContainEqual({ from: 'bank', to: 'send' })
    const empty = flowToDiagram({ ...flow, bank: { ...flow.bank, count: 0 } })
    expect(empty.nodes.find((x) => x.id === 'bank')).toBeUndefined()
  })
})

describe('skillToDiagram', () => {
  it('draws a planned straight pipeline from the steps', () => {
    const d = skillToDiagram({
      name: 'Kaspen',
      steps: [
        { type: 'note', text: 'Source: Apollo via Leadsfriday' },
        { type: 'import' },
        { type: 'validate', note: 'finder → validator' },
        { type: 'apify_actor', actor_id: 'x/y', actor_name: 'Google Maps', input_template: {}, budget_usd: 12 },
        { type: 'launch' },
      ],
    })
    expect(diagramSchema.safeParse(d).success).toBe(true)
    expect(d.title).toBe('Kaspen')
    expect(d.nodes.every((x) => x.state === 'planned')).toBe(true)
    expect(d.nodes[3]).toMatchObject({ kind: 'source', detail: 'Google Maps · ≤ $12' })
    expect(d.edges).toHaveLength(4)
  })
})
