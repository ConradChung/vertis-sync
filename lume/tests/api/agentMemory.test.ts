import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ requireOwner: vi.fn(), listMemories: vi.fn(), addMemory: vi.fn(), archiveMemory: vi.fn(), searchPastChats: vi.fn() }))
vi.mock('@/lib/auth/guards', () => ({ requireOwner: h.requireOwner }))
vi.mock('@/lib/agent/memory', () => ({ listMemories: h.listMemories, addMemory: h.addMemory, archiveMemory: h.archiveMemory, searchPastChats: h.searchPastChats }))
vi.mock('@/lib/db/service', () => ({ isDbError: () => false }))

import { GET, POST } from '@/app/api/agent/memory/route'
import { DELETE } from '@/app/api/agent/memory/[id]/route'
import { GET as searchGET } from '@/app/api/agent/past-chats/route'

const ID = '0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c'
const req = (url: string, method = 'GET', body?: unknown) => new Request(`http://localhost${url}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireOwner.mockResolvedValue({ ok: true, via: 'session' })
})

describe('/api/agent/memory', () => {
  it('lists memories', async () => {
    h.listMemories.mockResolvedValue([{ id: ID, kind: 'client', content: 'Kaspen' }])
    expect(await (await GET(req('/api/agent/memory'))).json()).toEqual({ memories: [{ id: ID, kind: 'client', content: 'Kaspen' }] })
  })

  it('saves a memory with its source conversation', async () => {
    h.addMemory.mockResolvedValue({ memory: { id: ID }, duplicate: false })
    const res = await POST(req('/api/agent/memory', 'POST', { kind: 'preference', content: 'Always exclude franchises', conversation_id: ID }))
    expect(res.status).toBe(201)
    expect(h.addMemory).toHaveBeenCalledWith('preference', 'Always exclude franchises', ID)
    expect((await POST(req('/api/agent/memory', 'POST', { kind: 'gossip', content: 'x' }))).status).toBe(400)
  })

  it('forgets one memory', async () => {
    h.archiveMemory.mockResolvedValue(true)
    expect((await DELETE(req(`/api/agent/memory/${ID}`, 'DELETE'), { params: Promise.resolve({ id: ID }) })).status).toBe(200)
    h.archiveMemory.mockResolvedValue(false)
    expect((await DELETE(req(`/api/agent/memory/${ID}`, 'DELETE'), { params: Promise.resolve({ id: ID }) })).status).toBe(404)
  })

  it('is owner-only', async () => {
    const { NextResponse } = await import('next/server')
    h.requireOwner.mockResolvedValue({ ok: false, response: NextResponse.json({}, { status: 401 }) })
    expect((await GET(req('/api/agent/memory'))).status).toBe(401)
  })
})

describe('/api/agent/past-chats (search_past_chats)', () => {
  it('searches and validates the query', async () => {
    h.searchPastChats.mockResolvedValue([{ conversation_id: ID, title: 'Kaspen', snippet: '…Kaspen ICP…' }])
    const body = await (await searchGET(req('/api/agent/past-chats?q=kaspen'))).json()
    expect(body.hits[0].title).toBe('Kaspen')
    expect(h.searchPastChats).toHaveBeenCalledWith('kaspen')
    expect((await searchGET(req('/api/agent/past-chats?q=k'))).status).toBe(400)
  })
})
