import { describe, expect, it, vi } from 'vitest'
import { TOOL_TIERS } from '@/lib/agent/permissions'
import { buildTools } from '@/lib/agent/tools'

const JOB = '16f26ffc-1111-4111-8111-111111111111'

function setup(reply: (url: string) => unknown) {
  const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(reply(String(url))), { status: 200 }))
  const tools = buildTools({ fetch: fetch as never, createAction: vi.fn(), prepare: vi.fn() as never, agentRunId: 'r', baseUrl: 'https://lume.test', secret: 's' })
  const tool = tools.find((t) => t.name === 'get_validation_stats')!
  return { fetch, run: (input: unknown) => tool.run(tool.inputSchema.parse(input)) }
}

describe('get_validation_stats', () => {
  it('is read tier', () => expect(TOOL_TIERS.get_validation_stats).toBe('read'))

  it('one job: invalid rate, errors apart, breakdown by reason', async () => {
    const { run, fetch } = setup(() => ({
      id: JOB, filename: 'pm.csv', status: 'processing', total_rows: 5272,
      reasons: [{ status: 'valid', reason: 'Accepted', n: 90 }, { status: 'invalid', reason: 'Catch-All', n: 10 }, { status: 'error', reason: 'Timeout', n: 5 }],
    }))
    const r = (await run({ job_id: JOB })) as { job: Record<string, unknown>; stats: Record<string, unknown> }
    expect(fetch.mock.calls[0][0]).toBe(`https://lume.test/api/jobs/${JOB}`)
    expect(r.job).toMatchObject({ id: JOB, filename: 'pm.csv', status: 'processing', total_rows: 5272 })
    expect(r.stats).toMatchObject({ invalid_rate: 10, error: 5, decided: 100 })
  })

  it('no job: the recent completed jobs with their source and rates (to answer "the last Leadsfriday list")', async () => {
    const { run, fetch } = setup(() => ({ rows: [{ id: 'j1', source: 'Leadsfriday (Apollo link)', invalid_rate: 12.5 }], total: 1 }))
    const r = (await run({})) as { jobs: unknown[] }
    expect(String(fetch.mock.calls[0][0])).toBe('https://lume.test/api/validation/history?page=0&page_size=15&days=90')
    expect(r.jobs).toEqual([{ id: 'j1', source: 'Leadsfriday (Apollo link)', invalid_rate: 12.5 }])
  })
})
