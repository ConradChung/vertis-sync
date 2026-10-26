import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  requireOwnerSession: vi.fn(),
  listDiagrams: vi.fn(),
  getDiagram: vi.fn(),
  saveDiagram: vi.fn(),
  renameDiagram: vi.fn(),
  archiveDiagram: vi.fn(),
}))
vi.mock('@/lib/auth/guards', () => ({ requireOwnerSession: h.requireOwnerSession }))
vi.mock('@/lib/playground/diagrams', () => ({
  listDiagrams: h.listDiagrams,
  getDiagram: h.getDiagram,
  saveDiagram: h.saveDiagram,
  renameDiagram: h.renameDiagram,
  archiveDiagram: h.archiveDiagram,
}))
vi.mock('@/lib/db/service', () => ({ isDbError: () => false }))

import { GET as listGET, POST } from '@/app/api/playground/diagrams/route'
import { DELETE, GET, PATCH } from '@/app/api/playground/diagrams/[id]/route'

const ID = '0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c'
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) })
const req = (method = 'GET', body?: unknown) =>
  new Request(`http://localhost/api/playground/diagrams/${ID}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) })
const spec = { title: 'P', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b' }] }
const row = { id: ID, title: 'P', spec, source_conversation_id: null }

beforeEach(() => {
  vi.clearAllMocks()
  h.requireOwnerSession.mockResolvedValue({ ok: true, via: 'session', user: {} })
})

describe('/api/playground/diagrams', () => {
  it('refuses without an owner session', async () => {
    h.requireOwnerSession.mockResolvedValue({ ok: false, response: new Response(null, { status: 401 }) })
    expect((await listGET(req())).status).toBe(401)
    expect((await POST(req('POST', { spec }))).status).toBe(401)
    expect(h.saveDiagram).not.toHaveBeenCalled()
  })

  it('GET lists saved diagrams', async () => {
    h.listDiagrams.mockResolvedValue([row])
    expect(await (await listGET(req())).json()).toEqual({ diagrams: [row] })
  })

  it('POST saves a new spec (201) and reuses an identical one (200)', async () => {
    h.saveDiagram.mockResolvedValueOnce({ diagram: row, created: true }).mockResolvedValueOnce({ diagram: row, created: false })
    const first = await POST(req('POST', { spec, title: 'P' }))
    expect(first.status).toBe(201)
    const second = await POST(req('POST', { spec, title: 'P' }))
    expect(second.status).toBe(200)
    expect((await second.json()).diagram.id).toBe(ID)
  })

  it('POST rejects an invalid spec', async () => {
    const res = await POST(req('POST', { spec: { nodes: [{ id: 'a', label: 'A' }], edges: [{ from: 'a', to: 'zzz' }] } }))
    expect(res.status).toBe(400)
    expect(h.saveDiagram).not.toHaveBeenCalled()
  })

  it('GET / PATCH / DELETE one diagram', async () => {
    h.getDiagram.mockResolvedValue(row)
    expect((await GET(req(), ctx())).status).toBe(200)
    h.getDiagram.mockResolvedValue(null)
    expect((await GET(req(), ctx())).status).toBe(404)
    h.renameDiagram.mockResolvedValue({ ...row, title: 'New' })
    expect((await (await PATCH(req('PATCH', { title: 'New' }), ctx())).json()).diagram.title).toBe('New')
    expect((await PATCH(req('PATCH', { title: '' }), ctx())).status).toBe(400)
    h.archiveDiagram.mockResolvedValue(true)
    expect((await DELETE(req('DELETE'), ctx())).status).toBe(200)
    expect((await GET(req(), ctx('not-a-uuid'))).status).toBe(400)
  })
})
