import { describe, expect, it } from 'vitest'
import { diagramSchema } from '@/lib/agent/diagram'
import { compactDetails, flowToDiagram, skillToDiagram } from '@/lib/playground/convert'
import type { CampaignFlowResponse, FlowStage } from '@/lib/campaigns/types'
import type { SkillStep } from '@/lib/agent/skillModel'

const stage = (id: FlowStage['id'], label: string, status: FlowStage['status'], count: number | null, hint: string | null = null): FlowStage => ({
  id,
  label,
  status,
  count,
  hint,
  source: `${label} source`,
  action: id === 'reply' ? { type: 'tab', tab: 'inbox', label: 'Open inbox' } : { type: 'link', href: '/import', label: 'Open Import' },
})

const flow = {
  campaign_id: 'c1',
  instantly: 'ok',
  campaign_status: 'paused',
  campaign_name: 'Scaleport - Fall Mega',
  counts: { imported: 0, validated: 0, enriched: 0, pushed: 0, sent: 1266, replies: 4, bank_total: 2212, bank_queued: 993, rotated: 1101, in_campaign: 1000 },
  jobs: [],
  gates: [],
  stages: [stage('import', 'Import', 'unused', 0, 'fed by the lead bank'), stage('send', 'Emails sent', 'done', 1266, 'paused'), stage('reply', 'Replies', 'done', 4)],
  bank: stage('bank', 'Lead bank', 'done', 2212, '993 queued · 994 sending · 225 finished'),
  feeders: [
    {
      id: 'system',
      kind: 'system',
      name: 'Auto-rotation',
      schedule: 'Daily at 6:00 AM and 6:00 PM',
      cron: ['0 13 * * *', '0 1 * * *'],
      active: true,
      next_run: 'Oct 26, 6:00 AM',
      last_run: 'Oct 25, 6:00 PM',
      last_result: 'added 1 lead',
      leads_added: 1101,
      leads_added_label: '1,101 added over 35 runs',
      href: '/rotate',
    },
  ],
} as unknown as CampaignFlowResponse

describe('converters fill details', () => {
  it('campaign flow: real numbers, sources, schedule and links', () => {
    const d = flowToDiagram(flow)
    expect(diagramSchema.safeParse(d).success).toBe(true)
    const n = Object.fromEntries(d.nodes.map((x) => [x.id, x]))
    const val = (id: string, label: string) => n[id].details?.data?.find((r) => r.label === label)?.value
    expect(val('send', 'Emails sent')).toBe('1,266')
    expect(val('send', 'Source')).toBe('Emails sent source')
    expect(val('send', 'Status')).toBe('paused')
    expect(val('reply', 'Reply rate')).toBe('0.3%')
    expect(n.send.details?.risks?.[0]).toMatch(/Reply rate under 0.5%/)
    expect(val('bank', 'Breakdown')).toContain('993 queued')
    expect(n.import.details?.why).toMatch(/^Not used for this campaign/)
    const feeder = n['feeder-system'].details!
    expect(feeder.data?.find((r) => r.label === 'Schedule')?.value).toBe('Daily at 6:00 AM and 6:00 PM')
    expect(feeder.links).toEqual([{ label: 'Open Rotate', url: '/rotate' }])
    expect(n.reply.details?.links?.[0].url).toBe('/crm?campaign=c1')
  })

  it('skill: actor, budget, inputs and variables', () => {
    const steps: SkillStep[] = [
      { type: 'apify_actor', actor_id: 'compass/crawler-google-places', actor_name: 'Google Maps Scraper', input_template: { searchStringsArray: ['{{industry}} in {{city}}'] }, budget_usd: 12 },
      { type: 'launch' },
    ]
    const d = skillToDiagram({ name: 'Roofers', steps, variables: [{ name: 'city', description: 'Target city', default: 'Austin, TX' }, { name: 'industry', description: '', default: 'roofers' }] })
    expect(diagramSchema.safeParse(d).success).toBe(true)
    const a = d.nodes[0].details!
    expect(a.actors?.[0]).toMatchObject({ id: 'compass/crawler-google-places', price: '≤ $12 per run' })
    expect(a.approval).toBe(true)
    expect(a.inputs).toEqual(['{{industry}}', '{{city}}'])
    expect(a.data?.some((r) => r.label === '{{city}}' && r.value.includes('Austin, TX'))).toBe(true)
    expect(d.nodes[1].details?.tools).toEqual(['activate_campaign'])
  })

  it('compactDetails drops empties and trims to the budget', () => {
    expect(compactDetails({ why: '', how: [], tools: undefined })).toBeUndefined()
    const big = compactDetails({ why: 'w'.repeat(600), data: Array.from({ length: 16 }, (_, i) => ({ label: `k${i}`, value: 'v'.repeat(150) })) })!
    expect(JSON.stringify(big).length).toBeLessThanOrEqual(1500)
    expect(big.why).toBeDefined()
  })
})
