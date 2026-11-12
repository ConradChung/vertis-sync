import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

// Per-table canned answers; each query records its filters.
const state = vi.hoisted(() => ({
  bank: null as Record<string, unknown> | null,
  jobs: [] as { id: string }[],
  rowsByJob: {} as Record<string, Record<string, unknown>>,
  queries: [] as { table: string; filters: [string, string, unknown][] }[],
}))

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      const q = { table, filters: [] as [string, string, unknown][] }
      state.queries.push(q)
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'order', 'limit']) b[m] = () => b
      for (const m of ['in', 'eq', 'ilike', 'or']) b[m] = (c: string, v: unknown) => (q.filters.push([m, c, v]), b)
      b.maybeSingle = () => Promise.resolve({ data: table === 'lead_bank' ? state.bank : null, error: null })
      b.then = (r: (v: unknown) => unknown) => {
        if (table === 'validation_jobs') return r({ data: state.jobs, error: null })
        if (table === 'validation_rows') {
          const job = q.filters.find(([m, c]) => m === 'eq' && c === 'job_id')?.[2] as string | undefined
          const ids = (q.filters.find(([m, c]) => m === 'in' && c === 'job_id')?.[2] as string[] | undefined) ?? (job ? [job] : [])
          const hit = ids.map((id) => state.rowsByJob[id]).find(Boolean)
          return r({ data: hit ? [{ row_data: hit }] : [], error: null })
        }
        return r({ data: [], error: null })
      }
      return b
    },
  }),
}))
vi.mock('@/lib/crm/service', () => ({ findDeal: vi.fn().mockResolvedValue(null) }))
vi.mock('@/lib/inbox/store', () => ({ getReply: vi.fn() }))

import { gatherFacts } from '@/lib/slack/facts'

const JOB = '16f26ffc-f8e5-47a5-9e1b-7532f61dad75'
const UK = '25c80373-b5c1-4b46-bb47-2faf37c8bd1e'
const reply = { campaign_id: UK, lead_email: 'Ann@Acme.co.uk', lead_name: null, company: null, excerpt: 'Yes please' }

describe('gatherFacts: phone from the lead’s own CSV run', () => {
  beforeEach(() => {
    state.queries.length = 0
    state.jobs = []
    state.rowsByJob = {}
    state.bank = { first_name: 'Ann', last_name: 'Lee', company_name: 'Acme', website: null, location: 'London', source_job_id: JOB }
  })

  it('reads the source job’s row even when the lead moved to a campaign no job was pushed to', async () => {
    state.rowsByJob[JOB] = { 'Mobile Phone': '', 'Corporate Phone': '+44 20 7946 0000', Title: 'Director' }
    const f = await gatherFacts(reply)
    expect(f.phone).toBe('+44 20 7946 0000')
    expect(state.queries.some((q) => q.table === 'validation_jobs')).toBe(false)
  })

  it('falls back to a job pushed to the campaign when the bank row has no source job', async () => {
    state.bank = { ...state.bank!, source_job_id: null }
    state.jobs = [{ id: 'job-2' }]
    state.rowsByJob['job-2'] = { 'Company Phone': '555-0100' }
    expect((await gatherFacts(reply)).phone).toBe('555-0100')
  })

  it('leaves the phone missing when no CSV row has one', async () => {
    state.rowsByJob[JOB] = { 'Mobile Phone': '' }
    expect((await gatherFacts(reply)).phone).toBeNull()
  })
})
