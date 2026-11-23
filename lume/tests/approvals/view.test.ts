import { describe, expect, it } from 'vitest'
import type { PendingActionRow } from '@/lib/db/types'
import { ageOf, badgeText, capOf, companyCheckRows, estimateOf, notifyWarning, pendingCheckBox, sortNewest, toApprovalItem } from '@/lib/approvals/view'

const row = (o: Partial<PendingActionRow> = {}): PendingActionRow => ({
  id: 'a1',
  kind: 'pause_campaign',
  payload: { summary: 'Pause Roofers' },
  risk: 'high',
  status: 'awaiting',
  claim_status: 'awaiting',
  requested_by: 'agent',
  agent_run_id: null,
  rule_id: null,
  telegram_message_id: null,
  decided_via: null,
  decided_at: null,
  executed_at: null,
  result: null,
  error: null,
  created_at: '2026-11-23T10:00:00Z',
  updated_at: '2026-11-23T10:00:00Z',
  ...o,
})

describe('capOf', () => {
  it('company_check: max_usd', () => {
    expect(capOf('company_check', { max_usd: 3.89, estimate_usd: 3.53 })).toBe(3.89)
  })
  it('influencer_lookup: max_usd', () => {
    expect(capOf('influencer_lookup', { max_usd: 2, estimate_usd: 1.5 })).toBe(2)
  })
  it('run_actor: the Apify hard cap (budget_usd), else cap_usd', () => {
    expect(capOf('run_actor', { budget_usd: 5, cap_usd: 20, estimate_usd: 1.25 })).toBe(5)
    expect(capOf('run_actor', { cap_usd: 20 })).toBe(20)
  })
  it('influencer_reactions: Apify charge cap + Perplexity verify cap', () => {
    expect(capOf('influencer_reactions', { reactions_usd: 4, max_charge_usd: 4.4, max_verify_usd: 10 })).toBe(14.4)
  })
  it('influencer_run: approved_usd, one-tap charge + verify, else the posts stop', () => {
    expect(capOf('influencer_run', { approved_usd: 7 })).toBe(7)
    expect(capOf('influencer_run', { one_tap: true, reactions_usd: 2, reactions_max_charge_usd: 2.2, max_verify_usd: 10 })).toBe(12.2)
    expect(capOf('influencer_run', { posts_usd: 0.5, posts_reserve_usd: 0.25, max_verify_usd: 10 })).toBe(0.75)
  })
  it('kinds that spend nothing: null', () => {
    expect(capOf('pause_campaign', { summary: 'x' })).toBeNull()
    expect(capOf('send_reply', {})).toBeNull()
    expect(capOf('company_check', null)).toBeNull()
  })
  it('ignores non-numbers', () => {
    expect(capOf('company_check', { max_usd: '3.89' })).toBeNull()
  })
})

describe('estimateOf', () => {
  it('reads each kind’s estimate', () => {
    expect(estimateOf('company_check', { estimate_usd: 3.53 })).toBe(3.53)
    expect(estimateOf('influencer_reactions', { reactions_usd: 4 })).toBe(4)
    expect(estimateOf('pause_campaign', {})).toBeNull()
  })
})

describe('notifyWarning', () => {
  it('skipped with a reason', () => {
    expect(notifyWarning({ notify_status: 'skipped', notify_error: 'missing token' })).toBe('Telegram not sent: missing token')
  })
  it('failed with a reason', () => {
    expect(notifyWarning({ notify_status: 'failed', notify_error: 'HTTP 429' })).toBe('Telegram not sent: HTTP 429')
  })
  it('failed or skipped without a reason', () => {
    expect(notifyWarning({ notify_status: 'failed', notify_error: null })).toBe('Telegram not sent: the send failed')
    expect(notifyWarning({ notify_status: 'skipped', notify_error: '  ' })).toBe('Telegram not sent')
  })
  it('sent, or null (filed before tracking): nothing', () => {
    expect(notifyWarning({ notify_status: 'sent', notify_error: null })).toBeNull()
    expect(notifyWarning({ notify_status: null, notify_error: 'stale' })).toBeNull()
    expect(notifyWarning({})).toBeNull()
  })
})

describe('toApprovalItem', () => {
  it('a company_check row: label, summary, cap, estimate, warning', () => {
    const it = toApprovalItem(row({ kind: 'company_check', payload: { summary: 'Check 500 companies', max_usd: 3.89, estimate_usd: 3.53 }, notify_status: 'skipped', notify_error: 'missing token' }))
    expect(it).toMatchObject({
      id: 'a1',
      kind: 'company_check',
      label: "Check each company's real business and ICP fit (spends money)",
      summary: 'Check 500 companies',
      cap_usd: 3.89,
      estimate_usd: 3.53,
      requested_by: 'agent',
      notify_warning: 'Telegram not sent: missing token',
      open_only: false,
    })
  })
  it('falls back to the label without a summary; issue_operator_key is decided on its page', () => {
    const it = toApprovalItem(row({ kind: 'issue_operator_key', payload: {} }))
    expect(it.summary).toBe('Issue a Grok Bot operator key')
    expect(it.open_only).toBe(true)
  })
})

describe('sortNewest / ageOf / badgeText', () => {
  it('newest first', () => {
    expect(sortNewest([{ created_at: '2026-11-01T00:00:00Z' }, { created_at: '2026-11-03T00:00:00Z' }]).map((r) => r.created_at)).toEqual(['2026-11-03T00:00:00Z', '2026-11-01T00:00:00Z'])
  })
  it('ages', () => {
    const now = new Date('2026-11-23T12:00:00Z')
    expect(ageOf('2026-11-23T11:59:30Z', now)).toBe('just now')
    expect(ageOf('2026-11-23T11:55:00Z', now)).toBe('5 min')
    expect(ageOf('2026-11-23T09:00:00Z', now)).toBe('3 h')
    expect(ageOf('2026-11-20T12:00:00Z', now)).toBe('3 d')
  })
  it('badge hidden at 0, capped at 99+', () => {
    expect(badgeText(0)).toBeNull()
    expect(badgeText(undefined)).toBeNull()
    expect(badgeText(3)).toBe('3')
    expect(badgeText(120)).toBe('99+')
  })
})

describe('company check rows', () => {
  const payload = { job_name: 'Roofers Oct', icp: 'Residential PMs', scope: 'sending', companies: 500, cached: 20, estimate_usd: 3.53, max_usd: 3.89, summary: 'x' }
  it('labelled job, ICP, scope, companies, estimate, cap', () => {
    expect(companyCheckRows(payload)).toEqual([
      ['job', 'Roofers Oct'],
      ['ICP', 'Residential PMs'],
      ['scope', 'Still sending'],
      ['companies', '500 to check (20 already checked, free)'],
      ['estimate', '$3.53'],
      ['cap', '$3.89'],
    ])
  })
  it('the ICP screen box links to the action', () => {
    const box = pendingCheckBox({ target_id: 'a9', counts: payload, created_at: '2026-11-23T10:00:00Z' })
    expect(box).toMatchObject({ href: '/actions/a9', heading: 'Pending action', filed: '2026-11-23T10:00:00Z' })
    expect(box.rows).toContainEqual(['cap', '$3.89'])
  })
})
