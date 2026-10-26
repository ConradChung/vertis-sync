import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireOwnerSession: vi.fn(),
  listConversations: vi.fn(),
  getConversation: vi.fn(),
  getMessages: vi.fn(),
  renameConversation: vi.fn(),
  archiveConversation: vi.fn(),
}))
vi.mock('@/lib/auth/guards', () => ({ requireOwnerSession: h.requireOwnerSession }))
vi.mock('@/lib/agent/conversations', () => ({
  listConversations: h.listConversations,
  getConversation: h.getConversation,
  getMessages: h.getMessages,
  renameConversation: h.renameConversation,
  archiveConversation: h.archiveConversation,
}))
vi.mock('@/lib/db/service', () => ({ isDbError: () => false }))

import { GET as listGET } from '@/app/api/agent/conversations/route'
import { DELETE, GET, PATCH } from '@/app/api/agent/conversations/[id]/route'

const ID = '0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c'
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) })
const req = (method = 'GET', body?: unknown) =>
  new Request(`http://localhost/api/agent/conversations/${ID}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) })
const conv = { id: ID, title: 'Gates today', created_at: '2026-10-25T10:00:00Z', updated_at: '2026-10-25T11:00:00Z' }

beforeEach(() => {
  vi.clearAllMocks()
  h.requireOwnerSession.mockResolvedValue({ ok: true, via: 'session', user: {} })
})

describe('/api/agent/conversations', () => {
  it('lists conversations', async () => {
    h.listConversations.mockResolvedValue([conv])
    const res = await listGET(req())
    expect(await res.json()).toEqual({ conversations: [conv] })
  })

  it('every handler is owner-session only (the agent bearer gets 403)', async () => {
    h.requireOwnerSession.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'session_required' }, { status: 403 }) })
    expect((await listGET(req())).status).toBe(403)
    expect((await GET(req(), ctx())).status).toBe(403)
    expect((await PATCH(req('PATCH', { title: 'x' }), ctx())).status).toBe(403)
    expect((await DELETE(req('DELETE'), ctx())).status).toBe(403)
    expect(h.listConversations).not.toHaveBeenCalled()
    expect(h.archiveConversation).not.toHaveBeenCalled()
  })

  it('a DB failure is a generic 500', async () => {
    h.listConversations.mockRejectedValue(new Error('relation agent_conversations does not exist'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await listGET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal' })
  })
})

describe('/api/agent/conversations/[id]', () => {
  it('GET returns the conversation and its messages', async () => {
    h.getConversation.mockResolvedValue(conv)
    h.getMessages.mockResolvedValue([{ id: 'm1', role: 'user', text: 'hi' }])
    const res = await GET(req(), ctx(ID.toUpperCase()))
    expect(h.getConversation).toHaveBeenCalledWith(ID)
    expect(await res.json()).toEqual({ conversation: conv, messages: [{ id: 'm1', role: 'user', text: 'hi' }] })
  })

  it('GET 404 when missing or deleted, 400 for a bad id', async () => {
    h.getConversation.mockResolvedValue(null)
    expect((await GET(req(), ctx())).status).toBe(404)
    expect((await GET(req(), ctx('nope'))).status).toBe(400)
    expect(h.getMessages).not.toHaveBeenCalled()
  })

  it('PATCH renames (trimmed) and validates the title', async () => {
    h.renameConversation.mockResolvedValue(true)
    const res = await PATCH(req('PATCH', { title: '  Weekly review  ' }), ctx())
    expect(await res.json()).toEqual({ ok: true, title: 'Weekly review' })
    expect(h.renameConversation).toHaveBeenCalledWith(ID, 'Weekly review')
    expect((await PATCH(req('PATCH', { title: '   ' }), ctx())).status).toBe(400)
    expect((await PATCH(req('PATCH', { title: 'x', archived_at: null }), ctx())).status).toBe(400)
    h.renameConversation.mockResolvedValue(false)
    expect((await PATCH(req('PATCH', { title: 'x' }), ctx())).status).toBe(404)
  })

  it('DELETE soft-deletes; 404 when already gone', async () => {
    h.archiveConversation.mockResolvedValue(true)
    expect(await (await DELETE(req('DELETE'), ctx())).json()).toEqual({ ok: true })
    expect(h.archiveConversation).toHaveBeenCalledWith(ID)
    h.archiveConversation.mockResolvedValue(false)
    expect((await DELETE(req('DELETE'), ctx())).status).toBe(404)
  })
})
