import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ getGate: vi.fn(), logEvent: vi.fn(), sendGatePing: vi.fn() }))
vi.mock('@/lib/db/service', () => ({ getGate: h.getGate, logEvent: h.logEvent }))
vi.mock('@/lib/adapters/telegram', () => ({ sendGatePing: h.sendGatePing }))
vi.mock('@/lib/supabase/service', async () => (await import('../stubs/feed')).serviceModule)
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
  it('pings Telegram exactly as before and writes one urgent row keyed like the pipeline prompt', async () => {
    const res = await hook({ kind: 'finder_decision', target_table: 'validation_jobs', target_id: ID })
    expect(await res.json()).toEqual({ ok: true, pinged: true })
    expect(h.sendGatePing).toHaveBeenCalledWith('finder_decision', ID, 'leads.csv')
    expect(feed.rows).toEqual([{
      source: 'lume.gates', severity: 'urgent', title: '🔗 leads.csv — open in Lume', body: '🔗 leads.csv — open in Lume',
      link: `/validate?gate=finder_decision:${ID}`, campaign_id: null, scope: 'validation', dedupe_key: `${ID}:finder_decision`, mode: 'reopen',
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
