import { beforeEach, describe, expect, it, vi } from 'vitest'

/** claimDecision records who decided: the owner in Lume, or the agent in skip mode. */
const updates: Record<string, unknown>[] = []
const filters: [string, unknown][] = []

function client() {
  return {
    from: () => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = (col: string, v: unknown) => {
        filters.push([col, v])
        return b
      }
      b.or = (expr: string) => {
        filters.push(['or', expr])
        return b
      }
      b.update = (patch: Record<string, unknown>) => {
        updates.push(patch)
        return b
      }
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: [{ id: 'a1' }], error: null })
      return b
    },
  }
}
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => client() }))

import { claimClientDecision, claimDecision, saveAwaitingPayload, saveClientEdit } from '@/lib/actions/store'

beforeEach(() => {
  updates.length = 0
  filters.length = 0
})

describe('claimDecision', () => {
  it("defaults to decided_via 'lume'", async () => {
    await claimDecision('a1', true)
    expect(updates[0]).toMatchObject({ decided_via: 'lume', status: 'approved' })
  })
  it("records decided_via 'agent' in skip mode", async () => {
    const row = await claimDecision('a1', true, 'agent')
    expect(updates[0]).toMatchObject({ decided_via: 'agent', status: 'approved' })
    expect(row).toEqual({ id: 'a1' })
    // Only an untouched row is claimable: a Telegram tap or Lume click that won first leaves nothing.
    expect(filters).toEqual(expect.arrayContaining([['id', 'a1'], ['claim_status', 'awaiting'], ['status', 'awaiting']]))
    expect(updates[0]).not.toHaveProperty('decided_by_operator')
  })
  it("records decided_via 'operator' and the deciding Grok Bot", async () => {
    await claimDecision('a1', false, 'operator', 'op-1')
    expect(updates[0]).toMatchObject({ decided_via: 'operator', decided_by_operator: 'op-1', status: 'rejected' })
  })
})

describe('client decisions in Slack (3g)', () => {
  it("records decided_via 'client' with the Slack user and team", async () => {
    await claimClientDecision('a1', false, { team: 'T0ABC', user: 'U0ABC' })
    expect(updates[0]).toMatchObject({ decided_via: 'client', status: 'rejected', decided_by_slack_user: 'U0ABC', decided_by_slack_team: 'T0ABC' })
    expect(filters).toEqual(expect.arrayContaining([['kind', 'send_reply'], ['claim_status', 'awaiting'], ['status', 'awaiting']]))
    expect(filters.find(([c]) => c === 'or')).toBeUndefined()
  })
  it('an approval excludes the editor of the current body in the same PATCH', async () => {
    await claimClientDecision('a1', true, { team: 'T0ABC', user: 'U0ABC' })
    expect(filters).toContainEqual(['or', 'edited_by_slack_user.is.null,edited_by_slack_user.neq.U0ABC'])
  })
  it('refuses malformed Slack ids before any write', async () => {
    await expect(claimClientDecision('a1', true, { team: 'T0ABC', user: 'x,edited_by_slack_user.is.null' })).rejects.toThrow()
    expect(updates).toHaveLength(0)
  })
  it("a client's edit records the editor; anyone else's edit clears it", async () => {
    await saveClientEdit('a1', { body: 'x' }, 'U0ABC')
    expect(updates[0]).toEqual({ payload: { body: 'x' }, edited_by_slack_user: 'U0ABC' })
    await saveAwaitingPayload('a1', { body: 'y' })
    expect(updates[1]).toEqual({ payload: { body: 'y' }, edited_by_slack_user: null })
  })
})
