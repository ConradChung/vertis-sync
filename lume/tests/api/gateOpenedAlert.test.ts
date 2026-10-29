import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ getGate: vi.fn(), logEvent: vi.fn(), sendGatePing: vi.fn() }))
vi.mock('@/lib/db/service', () => ({ getGate: h.getGate, logEvent: h.logEvent }))
vi.mock('@/lib/adapters/telegram', () => ({ sendGatePing: h.sendGatePing }))
vi.mock('@/lib/supabase/service', async () => (await import('../stubs/feed')).serviceModule)
const push = vi.hoisted(() => ({ pushForItem: vi.fn() }))
vi.mock('@/lib/webhooks/deliver', () => push)
import { feed } from '../stubs/feed'

import { POST } from '@/app/api/hooks/gate-opened/route'

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const SECRET = 'hook-secret'

const hook = (body: unknown) =>
  POST(new Request('http://localhost/api/hooks/gate-opened', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Lume-Hook-Secret': SECRET },
    body: JSON.stringify(body),
  }))

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset()
  process.env.LUME_HOOK_SECRET = SECRET
  delete process.env.ALERT_CHANNELS
  delete process.env.LUME_URL
  feed.rows = []
  h.getGate.mockResolvedValue({ title: 'leads.csv' })
  h.logEvent.mockResolvedValue(null)
  h.sendGatePing.mockResolvedValue({ ok: true, messageId: 9 })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('POST /api/hooks/gate-opened alerts (G4)', () => {
  it('pings Telegram exactly as before; touches the gate row keyed like the pipeline prompt (never overwrites it)', async () => {
    const res = await hook({ kind: 'finder_decision', target_table: 'validation_jobs', target_id: ID })
    expect(await res.json()).toEqual({ ok: true, pinged: true })
    expect(h.sendGatePing).toHaveBeenCalledWith('finder_decision', ID, 'leads.csv')
    expect(feed.rows).toEqual([{
      source: 'lume.gates', severity: 'urgent', title: '🔗 leads.csv — open in Lume', body: '🔗 leads.csv — open in Lume',
      link: `/validate?gate=finder_decision:${ID}`, campaign_id: null, scope: 'validation', dedupe_key: `${ID}:finder_decision`, mode: 'touch',
    }])
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ pinged: true, telegram_message_id: 9 }) }))
  })

  it('ALERT_CHANNELS=feed: no ping, pinged false, the feed row is still written', async () => {
    process.env.ALERT_CHANNELS = 'feed'
    const res = await hook({ kind: 'lfo_count', target_table: 'apollo_orders', target_id: ID })
    expect(await res.json()).toEqual({ ok: true, pinged: false })
    expect(h.sendGatePing).not.toHaveBeenCalled()
    expect(feed.rows[0]).toMatchObject({ scope: 'orders', dedupe_key: `${ID}:lfo_count` })
  })
})

describe('gate-opened shares the pipelines\' keys (G4 fix)', () => {
  it.each(['stall', 'jobs_stall', 'jobs_fill', 'jobs_review', 'jobs_write', 'push_review', 'campaign_choice', 'lume_action'])(
    '%s: <target id>:<kind>, no instance suffix', async (kind) => {
      await hook({ kind, target_table: 'validation_jobs', target_id: ID })
      expect(feed.rows.at(-1)).toMatchObject({ dedupe_key: `${ID}:${kind}`, mode: 'touch' })
    })
})

describe('gate-opened webhook push (3f)', () => {
  it('a new gate is a needs_confirmation push routed like the gate, with no title or PII', async () => {
    push.pushForItem.mockReset()
    h.getGate.mockResolvedValue({ kind: 'push_review', title: 'leads.csv', counts: { campaign_id: 'c-9' } })
    await hook({ kind: 'push_review', target_table: 'validation_jobs', target_id: ID })
    expect(push.pushForItem).toHaveBeenCalledWith(
      { campaign_id: 'c-9', scope: 'validation' },
      { type: 'needs_confirmation', item_id: ID, summary: 'New item needs confirmation: push review. Check /operator.', link: '/operator' }
    )
  })

  it('a lume_action gate is not pushed again (createAction already pushed that pending action)', async () => {
    push.pushForItem.mockReset()
    h.getGate.mockResolvedValue({ kind: 'lume_action', title: 'pause_campaign', counts: { campaign_id: 'c-9' } })
    await hook({ kind: 'lume_action', target_table: 'pending_actions', target_id: ID })
    expect(push.pushForItem).not.toHaveBeenCalled()
  })
})
