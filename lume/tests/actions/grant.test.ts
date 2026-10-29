import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingActionRow } from '@/lib/db/types'

const modes = vi.hoisted(() => ({ getReplyMode: vi.fn() }))
vi.mock('@/lib/inbox/replyModeStore', () => modes)
const inbox = vi.hoisted(() => ({ getReply: vi.fn(), listLeadReplies: vi.fn() }))
vi.mock('@/lib/inbox/store', () => inbox)
const store = vi.hoisted(() => ({ claimDecision: vi.fn() }))
vi.mock('@/lib/actions/store', () => store)
const svc = vi.hoisted(() => ({ logEvent: vi.fn() }))
vi.mock('@/lib/db/service', () => svc)
const next = vi.hoisted(() => ({ after: vi.fn() }))
vi.mock('next/server', () => next)
const exec = vi.hoisted(() => ({ executeAction: vi.fn() }))
vi.mock('@/lib/actions/execute', () => exec)

import { evaluateGrant, tryGrantSend } from '@/lib/actions/grant'

const payload = { summary: 's', campaign_id: 'c-1', campaign_verified: true, reply_to_uuid: 'u-1', lead_email: 'ada@acme.com', eaccount: 'me@x.com', body: 'hi', verdict: 'GOOD', their_message: 'Tuesday works', recipient_verified: true }
const row = (p: Record<string, unknown> = payload, kind = 'send_reply') => ({ id: 'a-1', kind, payload: p, status: 'awaiting' }) as unknown as PendingActionRow

beforeEach(() => {
  vi.resetAllMocks()
  modes.getReplyMode.mockResolvedValue('auto')
  inbox.getReply.mockResolvedValue({ handled_how: null, interest: 1 })
  inbox.listLeadReplies.mockResolvedValue([])
  store.claimDecision.mockImplementation(async (id: string) => ({ ...row(), id, status: 'approved', decided_via: 'grant' }))
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('the reply grant', () => {
  it('Auto mode approves a GOOD reply as grant and schedules the executor after the response', async () => {
    const out = await tryGrantSend(row())
    expect(out.granted).toBe(true)
    expect(store.claimDecision).toHaveBeenCalledWith('a-1', true, 'grant')
    expect(svc.logEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'lume.reply_auto_approved', source_id: 'a-1' }))
    expect(next.after).toHaveBeenCalledTimes(1)
    await next.after.mock.calls[0][0]()
    expect(exec.executeAction).toHaveBeenCalledWith('a-1')
  })

  it('outside a request scope the executor starts at once', async () => {
    next.after.mockImplementation(() => {
      throw new Error('outside request scope')
    })
    await tryGrantSend(row())
    await vi.waitFor(() => expect(exec.executeAction).toHaveBeenCalledWith('a-1'))
  })

  it('Owner and Client modes never claim (client is owner until 3g)', async () => {
    for (const m of ['owner', 'client']) {
      modes.getReplyMode.mockResolvedValue(m)
      expect(await tryGrantSend(row())).toEqual({ granted: false, reason: `mode_${m}` })
    }
    expect(store.claimDecision).not.toHaveBeenCalled()
    expect(inbox.listLeadReplies).not.toHaveBeenCalled()
  })

  it('a bot-drafted reply is still granted: the grant is not an operator (canApproveSend)', async () => {
    expect((await tryGrantSend(row({ ...payload, drafted_by_operator: 'op-1' }))).granted).toBe(true)
  })

  it('holds BAD, unsubscribe and hostile replies, and leads labelled BAD before', async () => {
    expect(await tryGrantSend(row({ ...payload, verdict: 'BAD' }))).toEqual({ granted: false, reason: 'verdict_bad' })
    expect(await tryGrantSend(row({ ...payload, their_message: 'unsubscribe' }))).toEqual({ granted: false, reason: 'opt_out_or_hostile' })
    inbox.listLeadReplies.mockResolvedValue([{ handled_how: 'label:bad_fit' }])
    expect(await tryGrantSend(row())).toEqual({ granted: false, reason: 'lead_labeled_negative' })
    expect(inbox.listLeadReplies).toHaveBeenCalledWith('c-1', 'ada@acme.com')
    expect(store.claimDecision).not.toHaveBeenCalled()
  })

  it('fails closed: a read error leaves it awaiting', async () => {
    modes.getReplyMode.mockRejectedValue(new Error('db down'))
    expect(await tryGrantSend(row())).toEqual({ granted: false, reason: 'error' })
    expect(store.claimDecision).not.toHaveBeenCalled()
  })

  it('a lost claim (someone decided first) is not a grant and runs nothing', async () => {
    store.claimDecision.mockResolvedValue(null)
    expect(await tryGrantSend(row())).toEqual({ granted: false, reason: 'already_decided' })
    expect(next.after).not.toHaveBeenCalled()
  })

  it('only send_reply; no lead address is unverified', async () => {
    expect((await tryGrantSend(row(payload, 'pause_campaign'))).granted).toBe(false)
    expect(await evaluateGrant({ ...payload, lead_email: undefined } as never)).toBe('recipient_unverified')
    expect(await evaluateGrant({ ...payload, campaign_id: undefined } as never)).toBe('no_campaign')
  })
})
