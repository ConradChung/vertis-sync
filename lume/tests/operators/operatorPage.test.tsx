import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CheckinData } from '@/lib/operators/checkinData'
import { describeGate } from '@/lib/operators/checkin'
import type { GateRow } from '@/lib/db/types'

const h = vi.hoisted(() => ({ loadCheckin: vi.fn(), currentOperator: vi.fn(), listCampaigns: vi.fn() }))
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }))
vi.mock('@/lib/operators/session', () => ({ currentOperator: h.currentOperator }))
vi.mock('@/lib/operators/checkinData', () => ({ loadCheckin: h.loadCheckin }))
vi.mock('@/lib/adapters/instantly', () => ({ isInstantlyConfigured: () => true, listCampaigns: h.listCampaigns }))
vi.mock('@/lib/import/client', () => ({ uploadCsvFile: vi.fn() }))

import OperatorPage from '@/app/(app)/operator/page'

const K = { id: 'v-k', name: 'Kaspen', campaign_ids: [], scopes: ['validation' as const], is_default: true, created_at: '', archived_at: null }
const JOB = '7db3d841-252c-4572-95ec-bc110727df8d'
const gate = (kind: GateRow['kind'], extra: Partial<GateRow> = {}): GateRow => ({
  kind, target_table: 'validation_jobs', target_id: 'x', title: 't', subtitle: 's', actions: [], counts: {}, telegram_message_id: null,
  created_at: '2026-10-26T00:00:00Z', ...extra,
})

function data(extra: Partial<CheckinData> = {}): CheckinData {
  const items = [
    describeGate(gate('lfo_count', { target_id: 'o1' }), [K]),
    describeGate(gate('campaign_choice', { target_id: JOB, counts: { valid_count: 12 } }), [K]),
    describeGate(gate('lume_action', { target_table: 'pending_actions', target_id: 'a1', title: 'pause_campaign' }), [K]),
  ]
  return {
    scope: { all: false, vertical: K },
    verticals: [K],
    operator: null,
    summary: { vertical: { id: 'v-k', name: 'Kaspen' }, needs_confirmation: 3, unacked_alerts: 1, urgent_alerts: 1, last_checked_at: null, generated_at: '2026-10-26T10:00:00.000Z' },
    items,
    alerts: [{ id: 'al1', source: 's', severity: 'urgent', title: 'Stalled', body: null, link: null, campaign_id: null, scope: null, created_at: '', acked_at: null, acked_by_operator: null, dedupe_key: null }],
    outcomes: [],
    operatorLabels: {},
    campaigns: [],
    campaignsNote: null,
    errors: [],
    ...extra,
  }
}

async function render(params: Record<string, string> = {}) {
  const el = await OperatorPage({ searchParams: Promise.resolve(params) })
  return renderToStaticMarkup(el)
}

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset()
  h.currentOperator.mockResolvedValue(null)
  h.loadCheckin.mockResolvedValue(data())
})

describe('/operator page', () => {
  it('leads with the machine-readable summary', async () => {
    const html = await render()
    const m = html.match(/<pre id="operator-summary"[^>]*>([\s\S]*?)<\/pre>/)
    expect(m).toBeTruthy()
    const json = JSON.parse(m![1].replace(/&quot;/g, '"'))
    expect(json).toMatchObject({ needs_confirmation: 3, unacked_alerts: 1, urgent_alerts: 1 })
  })

  it('renders real forms posting to the existing routes, returning to /operator', async () => {
    const html = await render({ vertical: 'v-k' })
    expect(html).toContain('action="/api/actions/a1/decide"')
    expect(html).toContain('name="decision" value="approve"')
    expect(html).toContain('action="/api/gates/decide"')
    expect(html).toContain(`value="lfo_count:o1"`)
    expect(html).toContain('name="count"')
    expect(html).toContain(`action="/api/gates/campaign/${JOB}"`)
    expect(html).toContain('name="campaign_query"')
    expect(html).toContain('action="/api/alerts/ack"')
    expect(html).toContain('action="/api/import/apollo-link"')
    expect(html).toContain('name="return_to" value="/operator?vertical=v-k"')
    expect(html).toContain('href="/agent?new=1&amp;vertical=v-k"')
    expect(html).not.toMatch(/<script/)
  })

  it('shows the flash and, after a several-match campaign query, the matches to pick', async () => {
    h.listCampaigns.mockResolvedValue([
      { id: 'c1', name: 'Scaleport - R3', status: 1 },
      { id: 'c2', name: 'Scaleport - Managers', status: 0 },
    ])
    const html = await render({ flash_error: '2 campaigns match', cq_job: JOB, cq: 'scaleport' })
    expect(html).toContain('id="flash-error"')
    expect(html).toContain('value="c1"')
    expect(html).toContain('Pick “Scaleport - Managers”')
  })
})
