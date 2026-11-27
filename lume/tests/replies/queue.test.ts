import { describe, expect, it } from 'vitest'
import type { ApprovalItem } from '@/lib/approvals/view'
import { mergeWaiting, overdueCount, type ReplyWaiting } from '@/lib/replies/queue'

const approval = (id: string, created_at: string): ApprovalItem => ({
  id, kind: 'send_reply', label: 'Reply', summary: 'Send a reply', cap_usd: null, estimate_usd: null, requested_by: 'agent', created_at, notify_warning: null, open_only: false,
})
const reply = (id: string, received_at: string): ReplyWaiting => ({
  reply_to_uuid: id, campaign_id: 'c1', lead_email: `${id}@example.com`, lead_name: null, company: null, subject: null, untrusted_excerpt: 'Sure, send it over', received_at, deal_id: null, draft_action_id: null,
})

describe('mergeWaiting (/replies)', () => {
  it('puts approvals and positive replies in one list, the longest wait first', () => {
    const items = mergeWaiting(
      [approval('a-new', '2026-11-26T19:50:00Z'), approval('a-old', '2026-11-26T15:00:00Z')],
      [reply('r-mid', '2026-11-26T18:00:00Z'), reply('r-oldest', '2026-11-25T10:00:00Z')]
    )
    expect(items.map((i) => i.key)).toEqual(['reply:r-oldest', 'approval:a-old', 'reply:r-mid', 'approval:a-new'])
    expect(items.map((i) => i.type)).toEqual(['reply', 'approval', 'reply', 'approval'])
    expect(items[0].since).toBe('2026-11-25T10:00:00Z')
  })
  it('at the same instant a reply comes before an approval; an unreadable time sorts last', () => {
    const t = '2026-11-26T18:00:00Z'
    expect(mergeWaiting([approval('a', t), approval('bad', 'nope')], [reply('r', t)]).map((i) => i.key)).toEqual(['reply:r', 'approval:a', 'approval:bad'])
    expect(mergeWaiting([], [])).toEqual([])
  })
  it('counts the items waiting past 5 minutes', () => {
    const now = new Date('2026-11-26T20:00:00Z')
    const items = mergeWaiting([approval('a', '2026-11-26T19:57:00Z'), approval('b', '2026-11-26T19:54:00Z')], [reply('r', '2026-11-26T19:55:00Z'), reply('s', '2026-11-26T12:00:00Z')])
    expect(overdueCount(items, now)).toBe(2)
  })
})
