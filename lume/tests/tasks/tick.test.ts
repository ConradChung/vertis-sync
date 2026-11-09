import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  getDueTasks: vi.fn(),
  claimDueTask: vi.fn(),
  claimReminder: vi.fn(),
  getTasksWithOpenActions: vi.fn(),
  getPushCandidates: vi.fn(),
  updateTask: vi.fn(),
}))
vi.mock('@/lib/tasks/store', () => Object.fromEntries(Object.keys(store).map((k) => [k, (...a: unknown[]) => store[k as keyof typeof store](...a)])))

const sync = vi.hoisted(() => ({ pullLinear: vi.fn(), pushTask: vi.fn() }))
vi.mock('@/lib/tasks/sync', () => ({ pullLinear: (...a: unknown[]) => sync.pullLinear(...a), pushTask: (...a: unknown[]) => sync.pushTask(...a) }))

const build = vi.hoisted(() => vi.fn())
vi.mock('@/lib/actions/build', () => ({ buildActionRequest: (...a: unknown[]) => build(...a) }))

const create = vi.hoisted(() => vi.fn())
vi.mock('@/lib/actions/create', async () => {
  class DuplicateActionError extends Error {
    existingId: string
    constructor(id: string) {
      super('dup')
      this.existingId = id
    }
  }
  class InvalidActionPayloadError extends Error {}
  return { createAction: (...a: unknown[]) => create(...a), DuplicateActionError, InvalidActionPayloadError }
})

const statuses = vi.hoisted(() => vi.fn())
vi.mock('@/lib/actions/store', () => ({ getActionStatuses: (...a: unknown[]) => statuses(...a) }))

const alerts = vi.hoisted(() => vi.fn())
vi.mock('@/lib/alerts', () => ({ alert: (...a: unknown[]) => alerts(...a), alertLink: (p: string) => p, titleFrom: (t: string) => t.split('\n')[0] }))
vi.mock('@/lib/adapters/telegram', () => ({ sendMessage: vi.fn(async () => ({ ok: true })) }))

import { runTaskTick } from '@/lib/tasks/tick'
import { DuplicateActionError } from '@/lib/actions/create'

const NOW = new Date('2026-11-20T17:05:00Z')
const task = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  title: 'Pull Austin leads',
  notes: null,
  due_at: '2026-11-20T17:00:00Z',
  all_day: true,
  action_kind: 'run_actor',
  action_payload: { actor_id: 'a/b', input: {} },
  status: 'scheduled',
  action_id: null,
  created_by: 'agent',
  updated_at: '2026-11-19T00:00:00Z',
  linear_synced_at: '2026-11-19T00:00:00Z',
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  store.getDueTasks.mockResolvedValue([])
  store.getTasksWithOpenActions.mockResolvedValue([])
  store.getPushCandidates.mockResolvedValue([])
  store.updateTask.mockResolvedValue({})
  sync.pullLinear.mockResolvedValue({ checked: 0, changed: [] })
  sync.pushTask.mockResolvedValue({ ok: true })
  statuses.mockResolvedValue(new Map())
  alerts.mockResolvedValue(undefined)
})

describe('runTaskTick: due action tasks', () => {
  it('claims, builds fresh and files an AWAITING action (never approves or executes)', async () => {
    store.getDueTasks.mockResolvedValue([task()])
    store.claimDueTask.mockResolvedValue(true)
    build.mockResolvedValue({ ok: true, kind: 'run_actor', payload: { summary: 'Run a/b', actor_id: 'a/b' } })
    create.mockResolvedValue({ id: 'act-1', status: 'awaiting' })
    const r = await runTaskTick(NOW)
    expect(store.claimDueTask).toHaveBeenCalledWith('t1', NOW.toISOString())
    expect(build).toHaveBeenCalledWith({ kind: 'run_actor', payload: { actor_id: 'a/b', input: {} } })
    expect(create).toHaveBeenCalledWith('run_actor', { summary: 'Run a/b', actor_id: 'a/b' }, 'agent', { ruleId: null })
    expect(store.updateTask).toHaveBeenCalledWith('t1', { action_id: 'act-1', last_error: null })
    expect(r.due).toEqual([{ task_id: 't1', outcome: 'filed', action_id: 'act-1' }])
    expect(alerts).toHaveBeenCalledWith(expect.objectContaining({ source: 'lume.calendar', link: '/calendar?task=t1' }))
  })

  it('an owner task is requested_by user', async () => {
    store.getDueTasks.mockResolvedValue([task({ created_by: 'owner' })])
    store.claimDueTask.mockResolvedValue(true)
    build.mockResolvedValue({ ok: true, kind: 'run_actor', payload: { summary: 's' } })
    create.mockResolvedValue({ id: 'act-2' })
    await runTaskTick(NOW)
    expect(create.mock.calls[0][2]).toBe('user')
  })

  it('a lost claim files nothing', async () => {
    store.getDueTasks.mockResolvedValue([task()])
    store.claimDueTask.mockResolvedValue(false)
    const r = await runTaskTick(NOW)
    expect(build).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(r.due).toEqual([{ task_id: 't1', outcome: 'skipped', reason: 'claimed_elsewhere' }])
  })

  it('a refused build fails the task with the reason', async () => {
    store.getDueTasks.mockResolvedValue([task()])
    store.claimDueTask.mockResolvedValue(true)
    build.mockResolvedValue({ ok: false, status: 422, error: 'invalid_input' })
    const r = await runTaskTick(NOW)
    expect(create).not.toHaveBeenCalled()
    expect(store.updateTask).toHaveBeenCalledWith('t1', { status: 'failed', last_error: 'invalid_input' })
    expect(r.due[0]).toMatchObject({ outcome: 'failed' })
  })

  it('a duplicate links the action already awaiting', async () => {
    store.getDueTasks.mockResolvedValue([task()])
    store.claimDueTask.mockResolvedValue(true)
    build.mockResolvedValue({ ok: true, kind: 'run_actor', payload: { summary: 's' } })
    create.mockRejectedValue(new DuplicateActionError('act-old'))
    const r = await runTaskTick(NOW)
    expect(r.due).toEqual([{ task_id: 't1', outcome: 'linked_existing', action_id: 'act-old' }])
    expect(store.updateTask).toHaveBeenCalledWith('t1', expect.objectContaining({ action_id: 'act-old' }))
  })

  it('a plain task sends one reminder and stays scheduled', async () => {
    store.getDueTasks.mockResolvedValue([task({ action_kind: null, action_payload: null })])
    store.claimReminder.mockResolvedValue(true)
    const r = await runTaskTick(NOW)
    expect(r.due).toEqual([{ task_id: 't1', outcome: 'reminded' }])
    expect(store.claimDueTask).not.toHaveBeenCalled()
    expect(store.updateTask).not.toHaveBeenCalled()
    expect(alerts).toHaveBeenCalledTimes(1)
  })
})

describe('runTaskTick: reconcile, sync, isolation', () => {
  it('moves tasks by their action status', async () => {
    store.getTasksWithOpenActions.mockResolvedValue([
      task({ id: 'a', status: 'awaiting_tap', action_id: 'x1' }),
      task({ id: 'b', status: 'running', action_id: 'x2' }),
      task({ id: 'c', status: 'awaiting_tap', action_id: 'x3' }),
    ])
    statuses.mockResolvedValue(new Map([['x1', 'approved'], ['x2', 'executed'], ['x3', 'awaiting']]))
    store.updateTask.mockResolvedValue({ id: 'ok' })
    const r = await runTaskTick(NOW)
    expect(r.reconciled).toEqual([{ task_id: 'a', status: 'running' }, { task_id: 'b', status: 'done' }])
    expect(store.updateTask).toHaveBeenCalledWith('b', { status: 'done' }, ['awaiting_tap', 'running'])
  })

  it('pushes only tasks changed since their last sync, capped', async () => {
    store.getPushCandidates.mockResolvedValue([
      task({ id: 'p1', linear_synced_at: null }),
      task({ id: 'p2', updated_at: '2026-11-20T00:00:00Z', linear_synced_at: '2026-11-19T00:00:00Z' }),
      task({ id: 'p3' }),
    ])
    const r = await runTaskTick(NOW)
    expect(sync.pushTask.mock.calls.map((c) => (c[0] as { id: string }).id)).toEqual(['p1', 'p2'])
    expect(r.pushed).toBe(2)
  })

  it('a failing step is reported and the rest still run; never throws', async () => {
    store.getDueTasks.mockRejectedValue(new Error('db down'))
    store.getPushCandidates.mockResolvedValue([task({ id: 'p1', linear_synced_at: null })])
    const r = await runTaskTick(NOW)
    expect(r.errors).toEqual(['due: db down'])
    expect(sync.pullLinear).toHaveBeenCalled()
    expect(r.pushed).toBe(1)
  })
})
