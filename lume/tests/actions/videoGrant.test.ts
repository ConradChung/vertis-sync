import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingActionRow } from '@/lib/db/types'

const em = vi.hoisted(() => ({ getEmail: vi.fn(), getThreadEmails: vi.fn() }))
vi.mock('@/lib/adapters/instantlyEmails', () => em)
const modes = vi.hoisted(() => ({ getReplyMode: vi.fn() }))
vi.mock('@/lib/inbox/replyModeStore', () => modes)
const inbox = vi.hoisted(() => ({ getReply: vi.fn(), listLeadReplies: vi.fn() }))
vi.mock('@/lib/inbox/store', () => inbox)
const store = vi.hoisted(() => ({ claimDecision: vi.fn() }))
vi.mock('@/lib/actions/store', () => store)
vi.mock('@/lib/db/service', () => ({ logEvent: vi.fn() }))
vi.mock('next/server', () => ({ after: vi.fn() }))
vi.mock('@/lib/actions/execute', () => ({ executeAction: vi.fn() }))

import { evaluateGrant, tryGrantSend } from '@/lib/actions/grant'
import { VIDEO_REPLY_DRAFTED_BY, videoReplyBody } from '@/lib/inbox/videoReply'

const UK = '25c80373-b5c1-4b46-bb47-2faf37c8bd1e'
const payload = {
  summary: 's', campaign_id: UK, campaign_verified: true, reply_to_uuid: 'u-1', lead_email: 'ann@acme.com', eaccount: 'frank@x.com',
  lead_name: 'Ann Lee', company: 'Acme PM', body: videoReplyBody('Ann Lee', 'Acme PM'), drafted_by: VIDEO_REPLY_DRAFTED_BY,
  their_message: 'Yes please', recipient_verified: true, verdict: 'GOOD',
}
const row = (p: Record<string, unknown> = payload) => ({ id: 'a-1', kind: 'send_reply', payload: p, status: 'awaiting' }) as unknown as PendingActionRow
const Q = 'Hi Ann…\nOpen to seeing a 2-min video of how it dispatches work orders?\n\nFrank'

beforeEach(() => {
  vi.resetAllMocks()
  modes.getReplyMode.mockResolvedValue('client')
  em.getEmail.mockResolvedValue({ id: 'u-1', thread_id: 't-1', direction: 'in', campaign_id: UK, interest: 1, text: 'Yes please\n\nOn Mon Frank wrote:\n> hi', lead: 'ann@acme.com' })
  em.getThreadEmails.mockResolvedValue({
    truncated: false,
    emails: [
      { id: 'o-1', direction: 'out', text: Q, created_at: '2026-11-10T10:00:00Z', at: null },
      { id: 'u-1', direction: 'in', text: 'Yes please', created_at: '2026-11-11T10:00:00Z', at: null },
    ],
  })
  inbox.getReply.mockResolvedValue({ handled_how: null, interest: 1 })
  inbox.listLeadReplies.mockResolvedValue([{ reply_to_uuid: 'u-1', handled_how: null }])
  store.claimDecision.mockImplementation(async () => ({ ...row(), status: 'approved', decided_via: 'grant' }))
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('the video-yes grant (Client-mode Kaspen campaigns)', () => {
  it('approves the exact video reply to a first plain yes', async () => {
    expect(await evaluateGrant(payload)).toBeNull()
    expect((await tryGrantSend(row())).granted).toBe(true)
  })
  it('an ordinary draft in Client mode still waits for a person', async () => {
    expect(await evaluateGrant({ ...payload, drafted_by: 'grok' })).toBe('mode_client')
  })
  it('an edited body waits', async () => {
    expect(await evaluateGrant({ ...payload, body: `${payload.body} PS` })).toBe('video_not_template')
  })
  it('more than a yes waits', async () => {
    em.getEmail.mockResolvedValue({ id: 'u-1', thread_id: 't-1', direction: 'in', campaign_id: UK, interest: 1, text: 'Yes, what does it cost?', lead: 'ann@acme.com' })
    expect(await evaluateGrant(payload)).toBe('video_not_plain_yes')
  })
  it('a yes to something other than the video question waits', async () => {
    em.getThreadEmails.mockResolvedValue({ truncated: false, emails: [{ id: 'o-1', direction: 'out', text: 'Who takes the 2am call?', created_at: '2026-11-10T10:00:00Z', at: null }, { id: 'u-1', direction: 'in', text: 'Yes', created_at: '2026-11-11T10:00:00Z', at: null }] })
    expect(await evaluateGrant(payload)).toBe('video_not_asked')
  })
  it('the shared safety checks still apply (opt-out, out of office, earlier closing label)', async () => {
    inbox.listLeadReplies.mockResolvedValue([{ reply_to_uuid: 'u-1', handled_how: 'label:not_interested' }])
    expect(await evaluateGrant(payload)).toBe('lead_labeled_negative')
    inbox.listLeadReplies.mockResolvedValue([{ reply_to_uuid: 'u-1', handled_how: null }])
    em.getEmail.mockResolvedValue({ id: 'u-1', thread_id: 't-1', direction: 'in', campaign_id: UK, interest: 0, text: 'Yes', lead: 'ann@acme.com' })
    expect(await evaluateGrant(payload)).toBe('out_of_office')
  })
})
