import { describe, expect, it, vi } from 'vitest'

const calls: [string, ...unknown[]][] = []
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => {
    const q: Record<string, (...a: unknown[]) => unknown> = {}
    for (const m of ['from', 'select', 'eq', 'limit']) {
      q[m] = (...a: unknown[]) => {
        calls.push([m, ...a])
        return m === 'limit' ? Promise.resolve({ data: [{ reply_to_uuid: 'r', handled_how: 'label:bad_fit', interest: -1 }], error: null }) : q
      }
    }
    return q
  },
}))

import { listLeadReplies } from '@/lib/inbox/store'

describe('listLeadReplies', () => {
  it('reads every recorded reply of the lead in ANY campaign (lowercased address, no campaign filter)', async () => {
    const rows = await listLeadReplies('Ada@Acme.com')
    expect(rows).toEqual([{ reply_to_uuid: 'r', handled_how: 'label:bad_fit', interest: -1 }])
    expect(calls).toContainEqual(['eq', 'lead_email', 'ada@acme.com'])
    expect(calls.some((c) => c[0] === 'eq' && c[1] === 'campaign_id')).toBe(false)
  })
})
