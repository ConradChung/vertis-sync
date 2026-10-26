import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingActionRow } from '@/lib/db/types'

const store = vi.hoisted(() => ({ claimExecution: vi.fn(), finishAction: vi.fn(), getAction: vi.fn() }))
vi.mock('@/lib/actions/store', () => store)
vi.mock('@/lib/db/service', () => ({ getPushJob: vi.fn(), logEvent: vi.fn().mockResolvedValue(null) }))
vi.mock('@/lib/adapters/pipeline', () => ({ decide: vi.fn() }))
const ins = vi.hoisted(() => ({ getCampaignDetail: vi.fn(), pauseCampaign: vi.fn(), resumeCampaign: vi.fn(), sendReply: vi.fn(), createCampaignFrom: vi.fn() }))
vi.mock('@/lib/adapters/instantlyWrite', () => ins)
vi.mock('@/lib/adapters/telegram', () => ({ sendMessage: vi.fn() }))
const crm = vi.hoisted(() => ({ getDeal: vi.fn(), setStage: vi.fn() }))
vi.mock('@/lib/crm/service', () => crm)

import { executeAction } from '@/lib/actions/execute'
import { parseCrmClosePayload } from '@/lib/crm/actions'

const ID = '0a4c1e2f-5b6d-4e7f-8a9b-0c1d2e3f4a5b'
const DEAL = '5b7f2d1e-3c4a-4e8b-9f0a-1b2c3d4e5f60'
const row = (payload: Record<string, unknown>): PendingActionRow =>
  ({
    id: ID, kind: 'crm_close_deal', payload: { summary: 's', ...payload }, risk: 'high', status: 'executing', claim_status: 'claimed',
    requested_by: 'user', agent_run_id: null, rule_id: null, telegram_message_id: null, decided_via: 'lume', decided_at: null,
    executed_at: null, result: null, error: null, created_at: '', updated_at: '',
  }) as PendingActionRow

beforeEach(() => {
  vi.clearAllMocks()
  crm.getDeal.mockResolvedValue({ id: DEAL, stage: 'Interested' })
  crm.setStage.mockResolvedValue('Interested')
})

describe('crm_close_deal', () => {
  it('payload: Won/Lost only, reason required, summary server-written', () => {
    expect(parseCrmClosePayload({ deal_id: DEAL, stage: 'Replied', reason: 'x' }).ok).toBe(false)
    expect(parseCrmClosePayload({ deal_id: DEAL, stage: 'Won', reason: '' }).ok).toBe(false)
    const p = parseCrmClosePayload({ deal_id: DEAL.toUpperCase(), stage: 'Lost', reason: 'No budget', lead_email: 'a@b.co', summary: 'evil' })
    expect(p.ok && p.payload).toMatchObject({ deal_id: DEAL, stage: 'Lost', summary: 'Mark a@b.co as Lost: “No budget”' })
  })

  it('once approved, the executor applies the stage with the reason and sends nothing', async () => {
    store.claimExecution.mockResolvedValue(row({ deal_id: DEAL, stage: 'Won', reason: 'Signed' }))
    const out = await executeAction(ID)
    expect(out).toMatchObject({ ran: true, status: 'executed', result: { deal_id: DEAL, from: 'Interested', to: 'Won' } })
    expect(crm.setStage).toHaveBeenCalledWith(DEAL, 'Won', 'user', 'Signed', { via: 'pending_action' })
    for (const f of Object.values(ins)) expect(f).not.toHaveBeenCalled()
  })

  it('fails cleanly for a vanished deal or a non-closing stage', async () => {
    crm.getDeal.mockResolvedValueOnce(null)
    store.claimExecution.mockResolvedValue(row({ deal_id: DEAL, stage: 'Won', reason: 'x' }))
    expect(await executeAction(ID)).toMatchObject({ status: 'failed', error: 'deal not found' })
    store.claimExecution.mockResolvedValue(row({ deal_id: DEAL, stage: 'Replied', reason: 'x' }))
    expect(await executeAction(ID)).toMatchObject({ status: 'failed' })
    expect(crm.setStage).not.toHaveBeenCalled()
  })
})
