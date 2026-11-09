import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearLinearCache, createIssue, cycleFor, getIssues, getTeam, isLinearConfigured, LINEAR_URL, updateIssue } from '@/lib/adapters/linear'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  process.env.LINEAR_API_KEY = 'lin_test_key'
  clearLinearCache()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.LINEAR_API_KEY
  delete process.env.LINEAR_TEAM_KEY
})

const TEAM = {
  teams: {
    nodes: [
      {
        id: 'team-1',
        key: 'GTM',
        cyclesEnabled: false,
        activeCycle: null,
        states: {
          nodes: [
            { id: 's-done', type: 'completed', position: 3 },
            { id: 's-todo2', type: 'unstarted', position: 2 },
            { id: 's-todo', type: 'unstarted', position: 1 },
            { id: 's-prog', type: 'started', position: 2 },
            { id: 's-canc', type: 'canceled', position: 4 },
            { id: 's-back', type: 'backlog', position: 0 },
          ],
        },
      },
    ],
  },
}

describe('linear adapter (mocked fetch)', () => {
  it('is unconfigured without a key and throws before calling anything', async () => {
    delete process.env.LINEAR_API_KEY
    expect(isLinearConfigured()).toBe(false)
    await expect(getTeam()).rejects.toThrow('not configured')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('resolves the team by key (default GTM), first state per type, raw key header, cached', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: TEAM }))
    const team = await getTeam()
    expect(team).toMatchObject({ id: 'team-1', cyclesEnabled: false, states: { unstarted: 's-todo', started: 's-prog', completed: 's-done', canceled: 's-canc' } })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(LINEAR_URL)
    expect(init.headers.Authorization).toBe('lin_test_key')
    expect(JSON.parse(init.body).variables).toEqual({ key: 'GTM' })
    expect(init.signal).toBeInstanceOf(AbortSignal)
    await getTeam()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('creates an issue with project, due date and state; no cycle when absent', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: { issueCreate: { success: true, issue: { id: 'iss-1', identifier: 'GTM-7', url: 'https://linear.app/x/issue/GTM-7' } } } }))
    const ref = await createIssue({ teamId: 'team-1', projectId: 'p-1', title: 'Run actor', description: 'd', dueDate: '2026-11-20', stateId: 's-todo', cycleId: null })
    expect(ref.identifier).toBe('GTM-7')
    const input = JSON.parse(fetchMock.mock.calls[0][1].body).variables.input
    expect(input).toEqual({ teamId: 'team-1', projectId: 'p-1', title: 'Run actor', description: 'd', dueDate: '2026-11-20', stateId: 's-todo' })
  })

  it('updates an issue', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: { issueUpdate: { success: true, issue: { id: 'iss-1', identifier: 'GTM-7', url: 'u' } } } }))
    await updateIssue('iss-1', { dueDate: '2026-11-21', stateId: 's-canc' })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).variables).toEqual({ id: 'iss-1', input: { dueDate: '2026-11-21', stateId: 's-canc' } })
  })

  it('reads linked issues and flattens the state type', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: { issues: { nodes: [{ id: 'iss-1', title: 'T', dueDate: '2026-11-22', updatedAt: 'x', state: { type: 'canceled' } }] } } }))
    expect(await getIssues(['iss-1'])).toEqual([{ id: 'iss-1', title: 'T', dueDate: '2026-11-22', updatedAt: 'x', stateType: 'canceled' }])
    expect(await getIssues([])).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('GraphQL errors and HTTP errors throw LinearError without echoing the key', async () => {
    fetchMock.mockResolvedValueOnce(json({ errors: [{ message: 'Entity not found' }] }))
    await expect(updateIssue('nope', { title: 't' })).rejects.toThrow('Linear: Entity not found')
    fetchMock.mockResolvedValueOnce(json({}, 401))
    const err = await updateIssue('x', { title: 't' }).catch((e: Error) => e)
    expect(String(err)).toContain('HTTP 401')
    expect(String(err)).not.toContain('lin_test_key')
  })

  it('a timeout is a short error', async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('t'), { name: 'TimeoutError' }))
    await expect(getIssues(['a'])).rejects.toThrow('Linear timed out')
  })

  it('cycleFor: none with cycles off; active when inside; else the containing upcoming one', () => {
    const active = { id: 'c1', startsAt: '2026-11-09T00:00:00Z', endsAt: '2026-11-23T00:00:00Z' }
    const next = { id: 'c2', startsAt: '2026-11-23T00:00:00Z', endsAt: '2026-12-07T00:00:00Z' }
    expect(cycleFor({ cyclesEnabled: false, activeCycle: active, cycles: [active, next] }, '2026-11-10')).toBeNull()
    expect(cycleFor({ cyclesEnabled: true, activeCycle: active, cycles: [active, next] }, '2026-11-10')).toBe('c1')
    expect(cycleFor({ cyclesEnabled: true, activeCycle: active, cycles: [active, next] }, '2026-11-30')).toBe('c2')
    expect(cycleFor({ cyclesEnabled: true, activeCycle: active, cycles: [active, next] }, '2027-01-10')).toBeNull()
  })
})
