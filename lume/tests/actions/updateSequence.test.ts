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

// The SOP library is swapped per test: a lenient base by default, stricter ones to exercise the gate.
const sopLib = vi.hoisted(() => ({ current: null as unknown, error: null as Error | null }))
vi.mock('@/lib/copy/sop', async (orig) => {
  const real = await orig<typeof import('@/lib/copy/sop')>()
  return {
    ...real,
    loadSopLibrary: () => {
      if (sopLib.error) throw sopLib.error
      return sopLib.current
    },
  }
})

import { buildSopLibrary, SopError } from '@/lib/copy/sop'
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

const BASE = (banned = '[leverage]', placeholder = false) => `---
version: 1
placeholder: ${placeholder}
banned_phrases: ${banned}
word_count:
  step1: { min: 1, max: 500 }
  followup: { min: 1, max: 500 }
subject:
  casing: any
  max_words: 20
proof_points: []
personalization_fields: [city]
max_personalization_fields_per_email: 1
step1_cta:
  forbid_yes_no_meeting: true
  meeting_words: [a call]
fallbacks: { open_role: a, door_count: b, pms: c, jurisdiction: d, compliance_law: d, generic: e }
---
## Voice
`
const ZEN = `---
version: 1
client: zen
name: Zen
match:
  campaign_names: [zenport]
no_exclamation: true
sequence:
  steps: 4
---
## Zen
`
const useSop = (banned?: string, placeholder = false) => {
  sopLib.current = buildSopLibrary(BASE(banned, placeholder), [{ file: 'zen.md', raw: ZEN }])
}

function edited() {
  const e = toEditSteps(LIVE)
  e[1].variants[0].body = 'Bump, any thoughts?'
  return e
}

beforeEach(() => {
  vi.clearAllMocks()
  useSop()
  sopLib.error = null
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

describe('update_sequence: SOP gate', () => {
  it('refuses to build an edit that breaks the SOP, naming rule, step and variant', async () => {
    const steps = edited()
    steps[1].variants[0].body = 'Bump. We leverage AI.'
    const b = await buildActionRequest({ kind: 'update_sequence', payload: { campaign_id: CAMP, steps } })
    expect(b).toMatchObject({ ok: false, status: 422, error: 'sop_violations' })
    if (b.ok) return
    expect(b.problems).toEqual([expect.stringMatching(/^Step 2, variant A — banned_phrase: body uses the banned phrase "leverage"/)])
    expect(b.violations).toEqual([expect.objectContaining({ rule: 'banned_phrase', step: 2, variant: 'A' })])
    expect(camp.findAwaitingActionBy).not.toHaveBeenCalled()
  })

  it('refuses (never skips the lint) when the SOP is malformed', async () => {
    sopLib.error = new SopError('word_count.step1: min must be <= max')
    const b = await buildActionRequest({ kind: 'update_sequence', payload: { campaign_id: CAMP, steps: edited() } })
    expect(b).toMatchObject({ ok: false, status: 500, error: 'sop_invalid', problems: [expect.stringMatching(/min must be <= max/)] })
  })

  it("applies the client overlay matching the campaign's name; warnings ride along without blocking", async () => {
    seq.getSequenceFresh.mockResolvedValue({ ...fresh(LIVE), name: 'Zenport - Oct' })
    const p = await built()
    expect(p.sop_client).toBe('zen')
    expect(p.sop_warnings).toEqual([expect.stringMatching(/sequence_structure \(warning\): the sequence has 2 steps; the SOP plans 4/)])
    const loud = edited()
    loud[1].variants[0].body = 'Bump!'
    const b = await buildActionRequest({ kind: 'update_sequence', payload: { campaign_id: CAMP, steps: loud } })
    expect(b).toMatchObject({ ok: false, status: 422, error: 'sop_violations', problems: [expect.stringMatching(/Step 2, variant A — no_exclamation/), expect.stringMatching(/warning/)] })
  })

  it('createAction refuses a snapshot that breaks the SOP', async () => {
    const p = await built()
    useSop('[bump]')
    await expect(createAction('update_sequence', p, 'user')).rejects.toThrow(/sop_violations: Step 2, variant A — banned_phrase/)
  })

  it('the executor re-lints with the SOP as it is now: an edit approved before an SOP change is refused, nothing written', async () => {
    const p = await built()
    useSop('[bump]')
    store.claimExecution.mockResolvedValueOnce(row(p))
    const out = await executeAction(ID)
    expect(out).toMatchObject({ ran: true, status: 'failed', result: { sop_violations: [expect.stringMatching(/^Step 2, variant A — banned_phrase/)] } })
    expect(out.ran && out.error).toMatch(/Blocked by the cold-email SOP \(the base SOP\): 1 violation\.\n- Step 2, variant A — banned_phrase/)
    expect(seq.patchSequence).not.toHaveBeenCalled()
  })

  it('the executor refuses when the SOP cannot be loaded', async () => {
    const p = await built()
    sopLib.error = new SopError('boom')
    store.claimExecution.mockResolvedValueOnce(row(p))
    const out = await executeAction(ID)
    expect(out).toMatchObject({ ran: true, status: 'failed', result: { sop_invalid: true } })
    expect(seq.patchSequence).not.toHaveBeenCalled()
  })
})

describe('update_sequence: a placeholder base SOP only warns', () => {
  const leveraged = () => {
    const steps = edited()
    steps[1].variants[0].body = 'Bump. We leverage AI.'
    return steps
  }

  it('a campaign no client SOP covers goes through, the base violations kept as warnings', async () => {
    useSop(undefined, true)
    const b = await buildActionRequest({ kind: 'update_sequence', payload: { campaign_id: CAMP, steps: leveraged() } })
    expect(b.ok).toBe(true)
    if (!b.ok) return
    expect(b.payload.sop_client).toBeNull()
    expect(b.payload.sop_warnings).toEqual([expect.stringMatching(/^Step 2, variant A — banned_phrase \(warning\): body uses the banned phrase "leverage"/)])
    svc.insertPendingAction.mockResolvedValueOnce({ ...row(b.payload), status: 'awaiting' })
    await expect(createAction('update_sequence', b.payload, 'user')).resolves.toMatchObject({ kind: 'update_sequence' })
    store.claimExecution.mockResolvedValueOnce(row(b.payload))
    const out = await executeAction(ID)
    expect(out).toMatchObject({ ran: true, status: 'executed' })
    expect(seq.patchSequence).toHaveBeenCalledTimes(1)
  })

  it("a client SOP's own rules still block; the placeholder base's stay warnings", async () => {
    useSop(undefined, true)
    seq.getSequenceFresh.mockResolvedValue({ ...fresh(LIVE), name: 'Zenport - Oct' })
    const loud = leveraged()
    loud[1].variants[0].body = 'Bump! We leverage AI.'
    const b = await buildActionRequest({ kind: 'update_sequence', payload: { campaign_id: CAMP, steps: loud } })
    expect(b).toMatchObject({ ok: false, status: 422, error: 'sop_violations' })
    if (b.ok) return
    expect(b.violations?.filter((v) => v.severity !== 'warning').map((v) => v.rule)).toEqual(['no_exclamation'])
    expect(b.violations?.filter((v) => v.severity === 'warning').map((v) => v.rule).sort()).toEqual(['banned_phrase', 'sequence_structure'])
    // Without the overlay's violation it goes through, warnings attached.
    const ok = await buildActionRequest({ kind: 'update_sequence', payload: { campaign_id: CAMP, steps: leveraged() } })
    expect(ok).toMatchObject({ ok: true, payload: { sop_client: 'zen', sop_warnings: [expect.stringMatching(/banned_phrase \(warning\)/), expect.stringMatching(/sequence_structure/)] } })
  })

  it('once the base is not a placeholder its rules block (no client SOP needed)', async () => {
    useSop(undefined, false)
    const b = await buildActionRequest({ kind: 'update_sequence', payload: { campaign_id: CAMP, steps: leveraged() } })
    expect(b).toMatchObject({ ok: false, status: 422, error: 'sop_violations', violations: [expect.objectContaining({ rule: 'banned_phrase', step: 2 })] })
  })

  it('the executor applies the same downgrade', async () => {
    const p = await built()
    useSop('[bump]', true)
    store.claimExecution.mockResolvedValueOnce(row(p))
    expect(await executeAction(ID)).toMatchObject({ ran: true, status: 'executed' })
    expect(seq.patchSequence).toHaveBeenCalledTimes(1)
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
