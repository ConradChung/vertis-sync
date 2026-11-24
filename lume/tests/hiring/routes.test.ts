import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeAi, fakeApify, memoryStore } from './memoryStore'
import { JOB_COORDINATOR } from './fixtures'

// The cron route runs the real engine over in-memory ports.
const live = vi.hoisted(() => ({ liveDeps: null as unknown }))
vi.mock('@/lib/hiring/live', () => live)

// The sheet routes: owner guards + store mocked.
const h = vi.hoisted(() => ({
  requireOwner: vi.fn(),
  requireOwnerSession: vi.fn(),
  decideHiringRow: vi.fn(),
}))
vi.mock('@/lib/hiring/store', () => ({ decideHiringRow: h.decideHiringRow, listHiringRows: vi.fn(), getHiringConfig: vi.fn(), hiringStatus: vi.fn() }))

const { POST: cron } = await import('@/app/api/cron/hiring-signal/route')
const { POST: decide } = await import('@/app/api/signals/hiring/[id]/route')

const SECRET = 'hook-secret'
const tick = (body?: unknown, secret: string | null = SECRET) =>
  cron(
    new Request('http://x/api/cron/hiring-signal', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(secret ? { 'X-Lume-Hook-Secret': secret } : {}) },
      body: body === undefined ? '' : JSON.stringify(body),
    })
  )

beforeEach(() => vi.stubEnv('LUME_HOOK_SECRET', SECRET))
afterEach(() => vi.unstubAllEnvs())

describe('/api/cron/hiring-signal', () => {
  it('401 without the hook secret, and nothing runs', async () => {
    const m = memoryStore()
    const apify = fakeApify()
    live.liveDeps = { store: m.store, apify, ai: fakeAi() }
    expect((await tick(undefined, null)).status).toBe(401)
    expect((await tick(undefined, 'wrong')).status).toBe(401)
    expect(apify.startRun).not.toHaveBeenCalled()
  })

  it('a scheduled tick starts the enabled, due lane', async () => {
    const m = memoryStore()
    const apify = fakeApify()
    live.liveDeps = { store: m.store, apify, ai: fakeAi() }
    const res = await tick()
    expect(res.status).toBe(200)
    expect((await res.json()).started).toHaveLength(1)
  })

  it('the manual first run: one hiring run now with the given cap and items, even with the lane off', async () => {
    const m = memoryStore({ dry_run: true, lanes: { hiring: false } })
    const apify = fakeApify({ ds_apr1: [JOB_COORDINATOR] })
    live.liveDeps = { store: m.store, apify, ai: fakeAi() }
    const res = await tick({ lane: 'hiring', run_cap_usd: 0.5, max_items: 25, force: true })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.started).toEqual([expect.objectContaining({ lane: 'hiring', cap_usd: 0.5 })])
    expect(apify.startRun).toHaveBeenCalledWith('curious_coder/linkedin-jobs-scraper', expect.anything(), { timeout: 900, maxItems: 25, maxTotalChargeUsd: 0.5 })
    expect(m.runs[0].manual).toBe(true)
  })

  it('400 on a malformed override', async () => {
    live.liveDeps = { store: memoryStore().store, apify: fakeApify(), ai: fakeAi() }
    expect((await tick({ lane: 'everything', force: true })).status).toBe(400)
    expect((await tick({ lane: 'hiring', run_cap_usd: 100, force: true })).status).toBe(400)
  })
})

vi.mock('@/lib/auth/guards', async (orig) => ({ ...(await orig<typeof import('@/lib/auth/guards')>()), requireOwner: h.requireOwner, requireOwnerSession: h.requireOwnerSession }))

describe('/api/signals/hiring/[id] (Mark sent / Skip)', () => {
  const post = (id: string, body: unknown) => decide(new Request(`http://x/api/signals/hiring/${id}`, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) })

  beforeEach(() => {
    h.requireOwnerSession.mockResolvedValue({ ok: true, via: 'session', user: { id: 'u1', email: 'owner@example.com' } })
    h.decideHiringRow.mockReset()
  })

  it('new → sent once; a double click is a 409 no-op', async () => {
    h.decideHiringRow.mockResolvedValueOnce({ id: 7, status: 'sent' }).mockResolvedValueOnce(null)
    const a = await post('7', { decision: 'sent' })
    expect(a.status).toBe(200)
    expect(h.decideHiringRow).toHaveBeenCalledWith(7, 'sent', 'owner@example.com')
    const b = await post('7', { decision: 'sent' })
    expect(b.status).toBe(409)
  })

  it('skip, and refuses bad ids / decisions', async () => {
    h.decideHiringRow.mockResolvedValue({ id: 8, status: 'skipped' })
    expect((await post('8', { decision: 'skipped' })).status).toBe(200)
    expect((await post('x', { decision: 'sent' })).status).toBe(400)
    expect((await post('8', { decision: 'delete' })).status).toBe(400)
  })

  it('the owner session is required (the agent bearer is refused)', async () => {
    const { NextResponse } = await import('next/server')
    h.requireOwnerSession.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'session_required' }, { status: 403 }) })
    expect((await post('7', { decision: 'sent' })).status).toBe(403)
    expect(h.decideHiringRow).not.toHaveBeenCalled()
  })
})
