import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getClaims: async () => ({ data: { claims: { sub: 'owner-id', email: 'owner@example.com' } } }) } }),
}))
const sess = vi.hoisted(() => ({ currentOperator: vi.fn() }))
vi.mock('@/lib/operators/session', () => sess)
const seed = vi.hoisted(() => ({ createInboxProject: vi.fn() }))
vi.mock('@/lib/inbox/seedProject', () => seed)

import { POST } from '@/app/api/verticals/[id]/inbox-project/route'

const VID = '3941b73f-c74e-4cc5-9766-f0140e6ad9c9'
const req = (headers: Record<string, string> = {}) =>
  new Request(`http://localhost/api/verticals/${VID}/inbox-project`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', ...headers } })
const params = (id: string) => ({ params: Promise.resolve({ id }) })

beforeEach(() => {
  vi.resetAllMocks()
  sess.currentOperator.mockResolvedValue(null)
  process.env.LUME_ALLOWED_EMAIL = 'owner@example.com'
  vi.stubEnv('LUME_INTERNAL_SECRET', 'internal-secret')
})

describe('POST /api/verticals/<id>/inbox-project', () => {
  it('201 when the project was created, with what was seeded', async () => {
    seed.createInboxProject.mockResolvedValue({ ok: true, project: { id: 'p', name: 'R · Inbox' }, created_project: true, seeded: ['a'], kept: [] })
    const res = await POST(req(), params(VID))
    expect(res.status).toBe(201)
    expect(seed.createInboxProject).toHaveBeenCalledWith(VID)
    expect(await res.json()).toMatchObject({ ok: true, created_project: true })
  })

  it('200 on a re-run; the agent bearer may (create_inbox_project is low)', async () => {
    seed.createInboxProject.mockResolvedValue({ ok: true, project: { id: 'p', name: 'R · Inbox' }, created_project: false, seeded: [], kept: ['a'] })
    expect((await POST(req({ authorization: 'Bearer internal-secret' }), params(VID))).status).toBe(200)
  })

  it('409 with the conflict when the vertical already has another project', async () => {
    seed.createInboxProject.mockResolvedValue({ ok: false, error: 'vertical_has_project', project: { id: 'p9', name: 'Other' } })
    const res = await POST(req(), params(VID))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'vertical_has_project', project: { id: 'p9', name: 'Other' } })
  })

  it('404 vertical_not_found, 400 bad id', async () => {
    seed.createInboxProject.mockResolvedValue({ ok: false, error: 'vertical_not_found' })
    expect((await POST(req(), params(VID))).status).toBe(404)
    expect((await POST(req(), params('nope'))).status).toBe(400)
  })

  it("a vertical Grok Bot only for its own vertical; the master bot for any", async () => {
    seed.createInboxProject.mockResolvedValue({ ok: true, project: { id: 'p', name: 'x' }, created_project: false, seeded: [], kept: [] })
    sess.currentOperator.mockResolvedValue({ id: 'o', is_master: false, vertical_id: 'another' })
    expect((await POST(req(), params(VID))).status).toBe(403)
    sess.currentOperator.mockResolvedValue({ id: 'o', is_master: false, vertical_id: VID })
    expect((await POST(req(), params(VID))).status).toBe(200)
    sess.currentOperator.mockResolvedValue({ id: 'm', is_master: true, vertical_id: null })
    expect((await POST(req(), params(VID))).status).toBe(200)
  })

  it('unauthenticated without a session or bearer', async () => {
    expect((await POST(req({ authorization: 'Bearer wrong' }), params(VID))).status).toBe(401)
  })
})
