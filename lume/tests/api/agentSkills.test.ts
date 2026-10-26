import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireOwnerSession: vi.fn(),
  listSkills: vi.fn(),
  getSkill: vi.fn(),
  createSkill: vi.fn(),
  updateSkill: vi.fn(),
  archiveSkill: vi.fn(),
}))
vi.mock('@/lib/auth/guards', () => ({ requireOwnerSession: h.requireOwnerSession }))
vi.mock('@/lib/agent/skills', () => {
  class DuplicateSkillNameError extends Error {}
  return {
    DuplicateSkillNameError,
    listSkills: h.listSkills,
    getSkill: h.getSkill,
    createSkill: h.createSkill,
    updateSkill: h.updateSkill,
    archiveSkill: h.archiveSkill,
  }
})
vi.mock('@/lib/db/service', () => ({ isDbError: () => false }))

import { GET as listGET, POST } from '@/app/api/agent/skills/route'
import { DELETE, GET, PATCH } from '@/app/api/agent/skills/[id]/route'
import { DuplicateSkillNameError } from '@/lib/agent/skills'

const ID = '0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c'
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) })
const req = (method = 'GET', body?: unknown) =>
  new Request(`http://localhost/api/agent/skills/${ID}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) })
const skill = { id: ID, name: 'Roofers', description: '', steps: [{ type: 'launch' }], variables: [], run_count: 0 }

beforeEach(() => {
  vi.clearAllMocks()
  h.requireOwnerSession.mockResolvedValue({ ok: true, via: 'session', user: {} })
})

describe('/api/agent/skills', () => {
  it('GET lists skills', async () => {
    h.listSkills.mockResolvedValue([skill])
    expect(await (await listGET(req())).json()).toEqual({ skills: [skill] })
  })

  it('POST validates steps with zod and creates', async () => {
    h.createSkill.mockResolvedValue(skill)
    const res = await POST(req('POST', { name: 'Roofers', steps: [{ type: 'launch' }] }))
    expect(res.status).toBe(201)
    expect(h.createSkill).toHaveBeenCalledWith({ name: 'Roofers', description: '', steps: [{ type: 'launch' }], variables: [] })
  })

  it('POST rejects bad steps without writing', async () => {
    expect((await POST(req('POST', { name: 'X', steps: [{ type: 'send_email' }] }))).status).toBe(400)
    expect((await POST(req('POST', { name: 'X', steps: [] }))).status).toBe(400)
    expect(h.createSkill).not.toHaveBeenCalled()
  })

  it('POST 409 on a duplicate name', async () => {
    h.createSkill.mockRejectedValue(new DuplicateSkillNameError('dup'))
    expect((await POST(req('POST', { name: 'Roofers', steps: [{ type: 'launch' }] }))).status).toBe(409)
  })

  it('every handler is owner-session only', async () => {
    h.requireOwnerSession.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'session_required' }, { status: 403 }) })
    expect((await listGET(req())).status).toBe(403)
    expect((await POST(req('POST', { name: 'x', steps: [{ type: 'launch' }] }))).status).toBe(403)
    expect((await GET(req(), ctx())).status).toBe(403)
    expect((await PATCH(req('PATCH', { name: 'x' }), ctx())).status).toBe(403)
    expect((await DELETE(req('DELETE'), ctx())).status).toBe(403)
    expect(h.createSkill).not.toHaveBeenCalled()
    expect(h.archiveSkill).not.toHaveBeenCalled()
  })
})

describe('/api/agent/skills/[id]', () => {
  it('GET returns the skill (lowercased id), 404 when gone, 400 for a bad id', async () => {
    h.getSkill.mockResolvedValueOnce(skill)
    expect(await (await GET(req(), ctx(ID.toUpperCase()))).json()).toEqual({ skill })
    expect(h.getSkill).toHaveBeenCalledWith(ID)
    h.getSkill.mockResolvedValueOnce(null)
    expect((await GET(req(), ctx())).status).toBe(404)
    expect((await GET(req(), ctx('nope'))).status).toBe(400)
  })

  it('PATCH renames / re-describes only', async () => {
    h.updateSkill.mockResolvedValue({ ...skill, name: 'New' })
    expect((await PATCH(req('PATCH', { name: '  New  ' }), ctx())).status).toBe(200)
    expect(h.updateSkill).toHaveBeenCalledWith(ID, { name: 'New' })
    expect((await PATCH(req('PATCH', { steps: [] }), ctx())).status).toBe(400)
    expect((await PATCH(req('PATCH', {}), ctx())).status).toBe(400)
  })

  it('PATCH 404 when gone, 409 on a duplicate name', async () => {
    h.updateSkill.mockResolvedValueOnce(null)
    expect((await PATCH(req('PATCH', { name: 'A' }), ctx())).status).toBe(404)
    h.updateSkill.mockRejectedValueOnce(new DuplicateSkillNameError('A'))
    expect((await PATCH(req('PATCH', { name: 'A' }), ctx())).status).toBe(409)
  })

  it('DELETE soft-deletes; 404 when already gone', async () => {
    h.archiveSkill.mockResolvedValueOnce(true)
    expect((await DELETE(req('DELETE'), ctx())).status).toBe(200)
    h.archiveSkill.mockResolvedValueOnce(false)
    expect((await DELETE(req('DELETE'), ctx())).status).toBe(404)
  })
})
