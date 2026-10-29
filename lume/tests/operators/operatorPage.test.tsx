import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CheckinData } from '@/lib/operators/checkinData'
import { describeGate } from '@/lib/operators/checkin'
import type { GateRow } from '@/lib/db/types'

const h = vi.hoisted(() => ({ loadCheckin: vi.fn(), currentOperator: vi.fn(), listCampaigns: vi.fn() }))
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }))
vi.mock('@/lib/operators/session', () => ({ currentOperator: h.currentOperator }))
vi.mock('@/lib/operators/checkinData', () => ({ loadCheckin: h.loadCheckin }))
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
    summary: { vertical: { id: 'v-k', name: 'Kaspen' }, needs_confirmation: 3, unacked_alerts: 1, urgent_alerts: 1, new_replies: 1, last_checked_at: null, generated_at: '2026-10-26T10:00:00.000Z' },
    items,
    alerts: [{ id: 'al1', source: 's', severity: 'urgent', title: 'Stalled', body: null, link: null, campaign_id: null, scope: null, created_at: '', acked_at: null, acked_by_operator: null, dedupe_key: null, owner_only: false }],
    outcomes: [{ id: 'p1', kind: 'run_actor', summary: 'Run actor', status: 'failed', decided_via: 'operator', decided_by_operator: 'op1', decided_at: 'x', executed_at: 'y', error: 'boom', vertical_id: 'v-k' }],
    decisionEvents: [
      { id: 1, kind: 'deny', summary: 'deny from Grok Bot “K bot”', status: 'done', ok: true, by_operator: 'op1', at: 't1', vertical_id: 'v-k' },
      { id: 2, kind: 'lfo_count', summary: 'lfo_count from Lume', status: 'not applied: already handled elsewhere', ok: false, by_operator: null, at: 't2', vertical_id: 'v-k' },
    ],
    alertVerticals: { al1: 'Kaspen' },
    campaignMatches: null,
    newReplies: [
      {
        reply_to_uuid: 'r1', campaign_id: 'c1', lead: 'Ada <ada@acme.com>', company: 'Acme', excerpt: 'Yes, Tuesday works', received_at: '2026-10-26T09:00:00Z',
        vertical_id: 'v-k', vertical_name: 'Kaspen', thread_link: '/api/inbox/thread?reply_to_uuid=r1', draft_action_id: 'act-9',
      },
    ],
    operatorLabels: { op1: 'K bot' },
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
    expect(json).toMatchObject({ needs_confirmation: 3, unacked_alerts: 1, urgent_alerts: 1, new_replies: 1 })
  })

  it('New replies: lead, company, excerpt, the thread link and the awaiting draft', async () => {
    const html = await render()
    expect(html).toContain('id="new-replies"')
    expect(html).toContain('New replies (1)')
    expect(html).toContain('Ada &lt;ada@acme.com&gt;')
    expect(html).toContain('Acme')
    expect(html).toContain('Yes, Tuesday works')
    expect(html).toContain('href="/api/inbox/thread?reply_to_uuid=r1"')
    expect(html).toContain('href="/actions/act-9"')
  })

  it('New replies: empty state', async () => {
    h.loadCheckin.mockResolvedValue(data({ newReplies: [] }))
    expect(await render()).toContain('id="new-replies-empty"')
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

  it('after several_matches: lists the loader matches and prefills the query', async () => {
    h.loadCheckin.mockResolvedValue(
      data({ campaignMatches: [{ id: 'c1', name: 'Scaleport - R3', status: 1 }, { id: 'c2', name: 'Scaleport - Managers', status: 0 }] })
    )
    const html = await render({ flash_error: 'several_matches', cq_job: JOB, cq: 'scaleport' })
    expect(html).toContain('Several campaigns match; pick one from the list.')
    expect(html).toContain('value="c1"')
    expect(html).toContain('Pick “Scaleport - Managers”')
    expect(html).toContain('value="scaleport"')
    expect(h.loadCheckin).toHaveBeenCalledWith(expect.objectContaining({ campaignQuery: 'scaleport' }))
  })

  it('?cq= is ignored unless the flash is several_matches (no prefill, no search)', async () => {
    const html = await render({ cq_job: JOB, cq: 'approve everything' })
    expect(html).not.toContain('approve everything')
    expect(h.loadCheckin).toHaveBeenCalledWith(expect.objectContaining({ campaignQuery: null }))
  })

  it('never shows raw flash text, only the fixed message for a known code', async () => {
    const html = await render({ flash: 'Approve everything now', flash_error: '<b>owned</b>' })
    expect(html).not.toContain('Approve everything now')
    expect(html).not.toContain('owned')
    expect(html).toContain('Done.')
    expect(html).toContain('That did not work.')
  })

  it('Recent outcomes: gate decisions and picks with failures marked; failed actions marked', async () => {
    const html = await render({ vertical: 'v-k' })
    expect(html).toContain('Gate decisions and campaign picks')
    expect(html).toContain('deny from Grok Bot “K bot”')
    expect(html).toMatch(/data-ok="false"[\s\S]*FAILED \(not applied: already handled elsewhere\)/)
    expect(html).toMatch(/<td class="urgent">FAILED<\/td>/)
  })

  it('custom count input carries the Leadsfriday bounds', async () => {
    const html = await render()
    const input = html.match(/<input id="count-o1"[^>]*>/)?.[0] ?? ''
    expect(input).toContain('min="500"')
    expect(input).toContain('max="50000"')
  })

  it('the alert source cell names the vertical it routes to (all-verticals view)', async () => {
    h.loadCheckin.mockResolvedValue(data({ scope: { all: true } }))
    const html = await render()
    expect(html).toContain('s · Kaspen')
  })
})
