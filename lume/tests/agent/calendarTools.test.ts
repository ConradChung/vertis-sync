import { describe, expect, it, vi } from 'vitest'
import { TOOL_TIERS } from '@/lib/agent/permissions'
import { buildTools } from '@/lib/agent/tools'

const TID = '3f0c8a52-6a55-4c1b-9d7e-2f8a1c0b9e11'

function setup(body: unknown = { ok: true, task: { id: TID } }) {
  const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify(body)))
  const createAction = vi.fn()
  const prepare = vi.fn()
  const tools = buildTools({ fetch, createAction, prepare: prepare as never, agentRunId: 'r1', baseUrl: 'https://lume.test', secret: 's', conversationId: 'c0ffee00-0000-4000-8000-000000000001' })
  const tool = (name: string) => tools.find((t) => t.name === name)!
  const run = (name: string, input: unknown) => tool(name).run(tool(name).inputSchema.parse(input))
  return { fetch, createAction, prepare, tool, run }
}

describe('calendar tools', () => {
  it('tiers: list read; schedule / update / cancel low (scheduling spends nothing)', () => {
    expect(TOOL_TIERS.list_tasks).toBe('read')
    expect(TOOL_TIERS.schedule_task).toBe('low')
    expect(TOOL_TIERS.update_task).toBe('low')
    expect(TOOL_TIERS.cancel_task).toBe('low')
  })

  it('schedule_task with an approval tool posts the same request the tool would file, and files nothing now', async () => {
    const { fetch, run, createAction, prepare } = setup()
    const out = await run('schedule_task', {
      title: 'Pull Austin dentists',
      due: '2026-11-20',
      action: { tool: 'run_apify_actor', input: { actor_id: 'apify/google-maps', input: { q: 'dentist' }, max_charge_usd: 5, inputs_confirmed_by_owner: true } },
    })
    expect(fetch.mock.calls[0][0]).toBe('https://lume.test/api/tasks')
    const body = JSON.parse(fetch.mock.calls[0][1].body)
    expect(body).toMatchObject({
      title: 'Pull Austin dentists',
      due: '2026-11-20',
      action: { kind: 'run_actor', payload: { actor_id: 'apify/google-maps', input: { q: 'dentist' }, max_charge_usd: 5 } },
      conversation_id: 'c0ffee00-0000-4000-8000-000000000001',
    })
    expect(createAction).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
    expect(out).toMatchObject({ status: 'scheduled', deep_link: `/calendar?task=${TID}` })
    expect(String(out.note)).toMatch(/does not run on its own/)
  })

  it('schedule_task refuses a non-approval tool and invalid tool input before calling anything', async () => {
    const { fetch, run } = setup()
    await expect(run('schedule_task', { title: 't', due: '2026-11-20', action: { tool: 'list_orders', input: {} } })).rejects.toThrow(/not an approval tool/)
    await expect(run('schedule_task', { title: 't', due: '2026-11-20', action: { tool: 'run_apify_actor', input: { actor_id: 'x' } } })).rejects.toThrow(/Invalid input for run_apify_actor/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('a reminder posts without an action', async () => {
    const { fetch, run } = setup()
    await run('schedule_task', { title: 'Sprint review', due: '2026-11-21T10:00' })
    expect(JSON.parse(fetch.mock.calls[0][1].body).action).toBeUndefined()
  })

  it('update / cancel / list hit the task routes', async () => {
    const { fetch, run } = setup({ ok: true })
    await run('update_task', { task_id: TID, due: '2026-11-22' })
    expect(fetch.mock.calls[0][0]).toBe(`https://lume.test/api/tasks/${TID}`)
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'PATCH' })
    await run('cancel_task', { task_id: TID })
    expect(fetch.mock.calls[1][1]).toMatchObject({ method: 'DELETE' })
    await run('list_tasks', { from: '2026-11-01', to: '2026-12-01' })
    expect(fetch.mock.calls[2][0]).toBe('https://lume.test/api/tasks?from=2026-11-01&to=2026-12-01')
  })
})
