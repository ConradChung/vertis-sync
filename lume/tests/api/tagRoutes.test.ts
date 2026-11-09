import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getClaims: async () => ({ data: { claims: { sub: 'owner-id', email: 'owner@example.com' } } }) } }),
}))
const s = vi.hoisted(() => ({ setTag: vi.fn(), listTags: vi.fn() }))
const sess = vi.hoisted(() => ({ currentOperator: vi.fn() }))
vi.mock('@/lib/operators/session', () => sess)
vi.mock('@/lib/tags/store', () => {
  class UnknownTagError extends Error {}
  return { ...s, UnknownTagError }
})

import { GET, PATCH } from '@/app/api/tags/route'
import { UnknownTagError } from '@/lib/tags/store'

const KAS = '466d9a53-6450-49df-a063-8e66437efa8b'
const ROW = '0b0c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3'
const req = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/tags', { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), headers: { 'content-type': 'application/json', ...headers } })

beforeEach(() => {
  s.setTag.mockReset()
  s.listTags.mockReset()
  sess.currentOperator.mockReset()
  sess.currentOperator.mockResolvedValue(null)
  process.env.LUME_ALLOWED_EMAIL = 'owner@example.com'
  vi.stubEnv('LUME_INTERNAL_SECRET', 'internal-secret')
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('/api/tags', () => {
  it('GET lists the tags', async () => {
    s.listTags.mockResolvedValue([{ id: KAS, name: 'Kaspen / Zenport' }])
    expect(await (await GET(req('GET'))).json()).toEqual({ tags: [{ id: KAS, name: 'Kaspen / Zenport' }] })
  })

  it('PATCH sets a tag (owner session, or the agent bearer)', async () => {
    s.setTag.mockResolvedValue({ id: ROW, vertical_id: KAS, vertical_name: 'Kaspen / Zenport' })
    const res = await PATCH(req('PATCH', { table: 'job_batches', id: ROW.toUpperCase(), vertical_id: KAS }))
    expect(res.status).toBe(200)
    expect(s.setTag).toHaveBeenCalledWith({ table: 'job_batches', id: ROW }, KAS)
    const bearer = await PATCH(req('PATCH', { table: 'lume_tasks', id: ROW, vertical_id: null }, { authorization: 'Bearer internal-secret' }))
    expect(bearer.status).toBe(200)
    expect(s.setTag).toHaveBeenLastCalledWith({ table: 'lume_tasks', id: ROW }, null)
  })

  it('PATCH refuses bad bodies, unknown rows and unknown tags', async () => {
    expect((await PATCH(req('PATCH', { table: 'agent_runs', id: ROW, vertical_id: null }))).status).toBe(400)
    expect((await PATCH(req('PATCH', { table: 'job_batches', id: ROW }))).status).toBe(400)
    s.setTag.mockResolvedValueOnce(null)
    const missing = await PATCH(req('PATCH', { table: 'job_batches', id: ROW, vertical_id: KAS }))
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'not_found' })
    s.setTag.mockRejectedValueOnce(new UnknownTagError())
    expect(await (await PATCH(req('PATCH', { table: 'job_batches', id: ROW, vertical_id: KAS }))).json()).toEqual({ error: 'tag_not_found' })
  })

  it('a vertical Grok Bot may not retag; a wrong bearer is 401', async () => {
    sess.currentOperator.mockResolvedValue({ id: 'op', is_master: false, vertical_id: KAS })
    expect((await PATCH(req('PATCH', { table: 'job_batches', id: ROW, vertical_id: KAS }))).status).toBe(403)
    expect(s.setTag).not.toHaveBeenCalled()
    expect((await PATCH(req('PATCH', { table: 'job_batches', id: ROW, vertical_id: KAS }, { authorization: 'Bearer nope' }))).status).toBe(401)
  })
})
