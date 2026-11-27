import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deps, good, memoryStore, reply } from './memory'

// The cron route runs the real engine over in-memory ports.
const live = vi.hoisted(() => ({ liveDeps: vi.fn() }))
vi.mock('@/lib/content/live', () => live)

const { POST: cron } = await import('@/app/api/cron/content-gen/route')

const SECRET = 'hook-secret'
const tick = (body?: unknown, secret: string | null = SECRET) =>
  cron(
    new Request('http://x/api/cron/content-gen', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(secret ? { 'X-Lume-Hook-Secret': secret } : {}) },
      body: body === undefined ? '' : JSON.stringify(body),
    })
  )

beforeEach(() => vi.stubEnv('LUME_HOOK_SECRET', SECRET))
afterEach(() => vi.unstubAllEnvs())

describe('/api/cron/content-gen', () => {
  it('401 without the hook secret, and nothing runs', async () => {
    const m = memoryStore()
    const { d, write } = deps(m.store, [reply(good())])
    live.liveDeps.mockReturnValue(d)
    expect((await tick(undefined, null)).status).toBe(401)
    expect((await tick({ force: true, slot: 'proof' }, 'wrong')).status).toBe(401)
    expect(write).not.toHaveBeenCalled()
  })

  it('400 on a malformed manual body', async () => {
    const m = memoryStore()
    live.liveDeps.mockReturnValue(deps(m.store, []).d)
    expect((await tick({ force: true, slot: 'monday' })).status).toBe(400)
  })

  it('a forced run writes and stores a dry-run draft without touching Slack', async () => {
    const m = memoryStore()
    const { d, post } = deps(m.store, [reply(good()), reply(good()), reply(good())])
    live.liveDeps.mockReturnValue(d)
    const res = await tick({ force: true, slot: 'proof' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.draft.slot).toBe('proof')
    expect(post).not.toHaveBeenCalled()
    expect(m.drafts).toHaveLength(1)
  })
})
