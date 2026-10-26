import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingActionRow } from '@/lib/db/types'

// No DB, Telegram or Instantly network: store, services and the sequence adapter are mocked.
const store = vi.hoisted(() => ({
  claimExecution: vi.fn(),
  finishAction: vi.fn(),
  getAction: vi.fn(),
  getStaleApprovedIds: vi.fn(),
  failInterruptedActions: vi.fn(),
  insertQueuedLeads: vi.fn(),
  resolveLeadsByRefs: vi.fn(),
  resolveLeadsByFilter: vi.fn(),
  getRule: vi.fn(),
  activateRule: vi.fn(),
  deleteRule: vi.fn(),
}))
vi.mock('@/lib/actions/store', () => store)
const svc = vi.hoisted(() => ({
  logEvent: vi.fn(),
  getPushJob: vi.fn(),
  findAwaitingAction: vi.fn(),
  findAwaitingRuleAction: vi.fn(),
  insertPendingAction: vi.fn(),
  setActionMessageId: vi.fn(),
  getCampaignByExternalId: vi.fn(),
  getInstantlyEmailEvent: vi.fn(),
}))
vi.mock('@/lib/db/service', () => ({ ...svc, PUSH_REVIEW_STATUSES: [], isDbError: (e: unknown) => e instanceof Error && 'code' in e }))
const camp = vi.hoisted(() => ({ findAwaitingActionBy: vi.fn() }))
vi.mock('@/lib/campaigns/service', () => camp)
vi.mock('@/lib/adapters/telegram', () => ({ sendMessage: vi.fn(), sendActionPrompt: vi.fn().mockResolvedValue({ ok: false }) }))
vi.mock('@/lib/adapters/pipeline', () => ({ decide: vi.fn() }))
vi.mock('@/lib/adapters/instantlyPush', () => ({ getPushPreview: vi.fn() }))
vi.mock('@/lib/adapters/instantly', async (orig) => ({
  ...(await orig<typeof import('@/lib/adapters/instantly')>()),
  isInstantlyConfigured: () => true,
}))
const seq = vi.hoisted(() => ({ getSequenceFresh: vi.fn(), patchSequence: vi.fn() }))
vi.mock('@/lib/adapters/instantlySequences', async (orig) => ({
  ...(await orig<typeof import('@/lib/adapters/instantlySequences')>()),
  ...seq,
}))

import { buildActionRequest } from '@/lib/actions/build'
import { createAction, DuplicateActionError, InvalidActionPayloadError } from '@/lib/actions/create'
import { executeAction, EXECUTABLE_KINDS } from '@/lib/actions/execute'
import { hashSteps } from '@/lib/adapters/instantlySequences'
import { toEditSteps, type InstantlyStep } from '@/lib/campaigns/sequence'

const ID = '0a4c1e2f-5b6d-4e7f-8a9b-0c1d2e3f4a5b'
const CAMP = '869d73b3-5bf3-4f1c-ba8c-43ac6d0f529d'
const LIVE: InstantlyStep[] = [
  { type: 'email', delay: 0, variants: [{ subject: 'Hi {{firstName}}', body: '<div>Hello <b>there</b></div>' }] },
  { type: 'email', delay: 3, delay_unit: 'days', variants: [{ subject: '', body: '<div>Bump</div>' }] },
]
const fresh = (steps: InstantlyStep[]) => ({ name: 'Scaleport - Fall Mega', status: 2, steps, hash: hashSteps(steps) })

function row(payload: Record<string, unknown>): PendingActionRow {
  return {
    id: ID, kind: 'update_sequence', payload: payload as PendingActionRow['payload'], risk: 'high', status: 'executing', claim_status: 'claimed',
    requested_by: 'user', agent_run_id: null, rule_id: null, telegram_message_id: null, decided_via: 'lume', decided_at: null,
    executed_at: null, result: null, error: null, created_at: '', updated_at: '',
  }
}

function edited() {
  const e = toEditSteps(LIVE)
  e[1].variants[0].body = 'Bump, any thoughts?'
  return e
}

beforeEach(() => {
  vi.clearAllMocks()
  seq.getSequenceFresh.mockResolvedValue(fresh(LIVE))
  seq.patchSequence.mockResolvedValue({})
  camp.findAwaitingActionBy.mockResolvedValue(null)
  store.finishAction.mockResolvedValue(undefined)
})

async function built(extra: Record<string, unknown> = {}) {
  const b = await buildActionRequest({ kind: 'update_sequence', payload: { campaign_id: CAMP, steps: edited(), base_hash: hashSteps(LIVE), ...extra } })
  if (!b.ok) throw new Error(`build failed: ${b.error}`)
  return b.payload
}

describe('update_sequence: build', () => {
  it('freezes the PATCH body, the hash it replaces, a before/after and a summary', async () => {
    const p = await built()
    expect(p.campaign_id).toBe(CAMP)
    expect(p.before_hash).toBe(hashSteps(LIVE))
    const steps = p.steps as unknown as InstantlyStep[]
    expect(steps[0].variants[0].body).toBe('<div>Hello <b>there</b></div>') // untouched: original HTML
    expect(steps[1].variants[0].body).toBe('<div>Bump, any thoughts?</div>')
    expect(p.summary).toBe('Update the email sequence of Scaleport - Fall Mega: 1 step edited (2 steps after)')
    expect((p.after as unknown as { variants: { body: string }[] }[])[1].variants[0].body).toBe('Bump, any thoughts?')
  })

  it('refuses when the live sequence moved since the editor loaded it', async () => {
    const b = await buildActionRequest({ kind: 'update_sequence', payload: { campaign_id: CAMP, steps: edited(), base_hash: 'f'.repeat(32) } })
    expect(b).toEqual({ ok: false, status: 409, error: 'sequence_changed' })
  })

  it('refuses an edit with no changes, and invalid copy with the reasons', async () => {
    expect(await buildActionRequest({ kind: 'update_sequence', payload: { campaign_id: CAMP, steps: toEditSteps(LIVE) } })).toEqual({
      ok: false,
      status: 400,
      error: 'no_changes',
    })
    const bad = toEditSteps(LIVE)
    bad[0].variants[0].subject = ''
    const b = await buildActionRequest({ kind: 'update_sequence', payload: { campaign_id: CAMP, steps: bad } })
    expect(b).toMatchObject({ ok: false, status: 400, error: 'invalid_sequence', problems: ['Step 1: the first email needs a subject.'] })
  })

  it('createAction keeps one awaiting edit per campaign and validates the snapshot', async () => {
    const p = await built()
    camp.findAwaitingActionBy.mockResolvedValueOnce({ id: 'existing' })
    await expect(createAction('update_sequence', p, 'user')).rejects.toBeInstanceOf(DuplicateActionError)
    expect(camp.findAwaitingActionBy).toHaveBeenCalledWith('update_sequence', 'campaign_id', CAMP)
    await expect(createAction('update_sequence', { ...p, before_hash: 'nope' }, 'user')).rejects.toBeInstanceOf(InvalidActionPayloadError)
  })
})

describe('update_sequence: execute (after the tap)', () => {
  it('is an executable kind', () => expect(EXECUTABLE_KINDS).toContain('update_sequence'))

  it('PATCHes the confirmed steps once; a double tap is a no-op', async () => {
    const p = await built()
    store.claimExecution.mockResolvedValueOnce(row(p)).mockResolvedValueOnce(null)
    store.getAction.mockResolvedValue({ ...row(p), status: 'executed' })
    const first = await executeAction(ID)
    expect(first).toMatchObject({ ran: true, status: 'executed', result: { campaign_id: CAMP, steps: 2 } })
    expect(seq.patchSequence).toHaveBeenCalledWith(CAMP, p.steps)
    const second = await executeAction(ID)
    expect(second).toEqual({ ran: false, reason: 'not_claimable', status: 'executed' })
    expect(seq.patchSequence).toHaveBeenCalledTimes(1)
  })

  it('fails without writing when the sequence changed after the edit was filed', async () => {
    const p = await built()
    const moved: InstantlyStep[] = [{ ...LIVE[0], variants: [{ subject: 'Changed in Instantly', body: 'x' }] }, LIVE[1]]
    seq.getSequenceFresh.mockResolvedValue(fresh(moved))
    store.claimExecution.mockResolvedValueOnce(row(p))
    const out = await executeAction(ID)
    expect(out).toMatchObject({ ran: true, status: 'failed', result: { stale: true } })
    expect(out.ran && out.error).toMatch(/Sequence changed in Instantly.*Re-open the editor/)
    expect(seq.patchSequence).not.toHaveBeenCalled()
  })
})
