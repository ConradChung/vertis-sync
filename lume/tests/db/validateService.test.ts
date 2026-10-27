import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Fake query builder: each `from()` starts a chain that records every call;
 * awaiting the chain resolves the next queued result. Lets the tests assert
 * the conditional filters the writes carry.
 */
type Call = [string, ...unknown[]]
const chains: Call[][] = []
const results: { data: unknown; error: unknown; count?: number }[] = []

function client() {
  return {
    from: (table: string) => {
      const calls: Call[] = [['from', table]]
      chains.push(calls)
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'update', 'insert', 'eq', 'in', 'limit', 'maybeSingle', 'single', 'order', 'range']) {
        b[m] = (...args: unknown[]) => {
          calls.push([m, ...args])
          return b
        }
      }
      b.then = (resolve: (v: unknown) => unknown) => resolve(results.shift() ?? { data: null, error: null })
      return b
    },
  }
}
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => client() }))

import { pickCampaign, setBarriers, updatePendingRow } from '@/lib/db/service'

const JOB = '7db3d841-252c-4572-95ec-bc110727df8d'
const ROW = '2b1e6f0e-6c1d-4f43-9a6e-1f6f0c9f4a11'
const has = (calls: Call[], ...c: unknown[]) => calls.some((x) => JSON.stringify(x) === JSON.stringify(c))

beforeEach(() => {
  chains.length = 0
  results.length = 0
})

describe('pickCampaign', () => {
  it('updates only while awaiting a campaign, clears candidates, moves to configuring', async () => {
    results.push({ data: [{ id: JOB, instantly_prompt_message_id: 77 }], error: null })
    expect(await pickCampaign(JOB, { id: 'c1', name: 'R3' })).toEqual({ prompt_message_id: 77 })
    const c = chains[0]
    expect(has(c, 'from', 'validation_jobs')).toBe(true)
    expect(has(c, 'update', { instantly_campaign_id: 'c1', instantly_campaign_name: 'R3', instantly_campaign_candidates: null, instantly_status: 'configuring' })).toBe(true)
    expect(has(c, 'eq', 'id', JOB)).toBe(true)
    expect(has(c, 'in', 'instantly_status', ['awaiting_campaign', 'choosing_campaign'])).toBe(true)
  })
  it('false when nothing matched', async () => {
    results.push({ data: [], error: null })
    expect(await pickCampaign(JOB, { id: 'c1', name: 'R3' })).toBe(false)
  })
})

describe('setBarriers', () => {
  it('refuses while a push confirmation is awaiting (no update sent)', async () => {
    results.push({ data: { id: 'a1' }, error: null })
    expect(await setBarriers(JOB, { company_strict: true })).toBe('push_awaiting_confirmation')
    expect(chains).toHaveLength(1)
    const c = chains[0]
    expect(has(c, 'from', 'pending_actions')).toBe(true)
    expect(has(c, 'eq', 'status', 'awaiting')).toBe(true)
    expect(has(c, 'eq', 'kind', 'push_to_instantly')).toBe(true)
    expect(has(c, 'eq', 'payload->>job_id', JOB)).toBe(true)
  })
  it('updates only while configuring/reviewing_company', async () => {
    results.push({ data: null, error: null }, { data: [{ id: JOB }], error: null })
    expect(await setBarriers(JOB, { location_barrier: true })).toBe('ok')
    const c = chains[1]
    expect(has(c, 'update', { location_barrier: true })).toBe(true)
    expect(has(c, 'in', 'instantly_status', ['configuring', 'reviewing_company'])).toBe(true)
  })
  it('moved when the job left the barrier step', async () => {
    results.push({ data: null, error: null }, { data: [], error: null })
    expect(await setBarriers(JOB, { location_barrier: true })).toBe('moved')
  })
})

describe('updatePendingRow', () => {
  const parked = { finder_status: 'awaiting_decision', email_column: 'Email', column_order: ['first name', 'Email'] }

  it('job_running when the job is not parked at the finder prompt (no row read, no write)', async () => {
    results.push({ data: { ...parked, finder_status: 'running' }, error: null })
    expect(await updatePendingRow(JOB, ROW, { email: 'a@x.com' })).toEqual({ ok: false, reason: 'job_running' })
    expect(chains).toHaveLength(1)
  })

  it('not_pending when the row was already checked', async () => {
    results.push({ data: parked, error: null }, { data: { status: 'valid', email: 'o@x.com', row_data: {} }, error: null })
    expect(await updatePendingRow(JOB, ROW, { email: 'a@x.com' })).toEqual({ ok: false, reason: 'not_pending' })
    expect(chains).toHaveLength(2)
  })

  it('writes conditionally on status=pending, merging row_data and the email column', async () => {
    results.push(
      { data: parked, error: null },
      { data: { status: 'pending', email: 'o@x.com', row_data: { Email: 'o@x.com', 'first name': 'A', city: 'LA' } }, error: null },
      { data: [{ id: ROW, row_index: 4, email: 'a@x.com', status: 'pending', validation_result: null, enrichment_status: null, instantly_status: null, row_data: { 'first name': 'Ann' } }], error: null }
    )
    const r = await updatePendingRow(JOB, ROW, { email: 'a@x.com', row_data_patch: { 'first name': 'Ann' } })
    expect(r).toMatchObject({ ok: true, emailChanged: true, fields: ['first name'] })
    if (r.ok) {
      expect(r.row.first_name).toBe('Ann') // key resolved from column_order, case-insensitively
      expect(r.row.name_keys.first_name).toBe('first name')
    }
    const w = chains[2]
    expect(has(w, 'update', { row_data: { Email: 'a@x.com', 'first name': 'Ann', city: 'LA' }, email: 'a@x.com' })).toBe(true)
    expect(has(w, 'eq', 'id', ROW)).toBe(true)
    expect(has(w, 'eq', 'job_id', JOB)).toBe(true)
    expect(has(w, 'eq', 'status', 'pending')).toBe(true)
  })

  it('not_pending when the conditional write matched nothing (validator won the race)', async () => {
    results.push({ data: parked, error: null }, { data: { status: 'pending', email: 'o@x.com', row_data: {} }, error: null }, { data: [], error: null })
    expect(await updatePendingRow(JOB, ROW, { row_data_patch: { city: 'SF' } })).toEqual({ ok: false, reason: 'not_pending' })
  })
})
