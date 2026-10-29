import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireOwner: vi.fn(),
  listProjects: vi.fn(),
  getProject: vi.fn(),
  createProject: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  reorderProjects: vi.fn(),
  listItems: vi.fn(),
  getItemText: vi.fn(),
  projectBytes: vi.fn(),
  addNote: vi.fn(),
  addFile: vi.fn(),
  itemByStoragePath: vi.fn(),
  deleteItem: vi.fn(),
  moveConversation: vi.fn(),
  projectConversations: vi.fn(),
  signProjectUpload: vi.fn(),
  downloadProjectObject: vi.fn(),
  removeProjectObjects: vi.fn(),
  getVertical: vi.fn(),
  extractText: vi.fn(),
  recordPendingUpload: vi.fn(),
  clearPendingUpload: vi.fn(),
  stalePendingUploads: vi.fn(),
  pathsInUse: vi.fn(),
  deletePendingUploads: vi.fn(),
  currentOperator: vi.fn(),
  getConversation: vi.fn(),
}))
vi.mock('@/lib/operators/session', () => ({ currentOperator: h.currentOperator }))
vi.mock('@/lib/agent/conversations', () => ({ getConversation: h.getConversation }))
vi.mock('@/lib/auth/guards', async (orig) => ({ ...(await orig<typeof import('@/lib/auth/guards')>()), requireOwner: h.requireOwner }))
vi.mock('@/lib/agent/projects', async () => {
  class ProjectConflictError extends Error {
    constructor(readonly code: string) {
      super(code)
    }
  }
  class ProjectGoneError extends Error {}
  return {
    ProjectConflictError,
    ProjectGoneError,
    recordPendingUpload: h.recordPendingUpload,
    clearPendingUpload: h.clearPendingUpload,
    stalePendingUploads: h.stalePendingUploads,
    pathsInUse: h.pathsInUse,
    deletePendingUploads: h.deletePendingUploads,
    listProjects: h.listProjects,
    getProject: h.getProject,
    createProject: h.createProject,
    updateProject: h.updateProject,
    deleteProject: h.deleteProject,
    reorderProjects: h.reorderProjects,
    listItems: h.listItems,
    getItemText: h.getItemText,
    projectBytes: h.projectBytes,
    addNote: h.addNote,
    addFile: h.addFile,
    itemByStoragePath: h.itemByStoragePath,
    deleteItem: h.deleteItem,
    moveConversation: h.moveConversation,
    projectConversations: h.projectConversations,
  }
})
vi.mock('@/lib/agent/projectStorage', async () => ({
  PROJECT_UPLOAD_PATH: /^([0-9a-f-]{36})\/[0-9a-f-]{36}\.([a-z0-9]{1,8})$/,
  signProjectUpload: h.signProjectUpload,
  downloadProjectObject: h.downloadProjectObject,
  removeProjectObjects: h.removeProjectObjects,
}))
vi.mock('@/lib/agent/projectExtract', () => ({ extractText: h.extractText }))
vi.mock('@/lib/operators/store', () => ({ getVertical: h.getVertical }))
vi.mock('@/lib/db/service', () => ({ isDbError: () => false }))

import { ProjectConflictError, ProjectGoneError } from '@/lib/agent/projects'
import { POST as sweepPOST } from '@/app/api/cron/project-uploads/route'
import { GET as listGET, POST as createPOST } from '@/app/api/agent/projects/route'
import { DELETE as projectDELETE, GET as projectGET, PATCH as projectPATCH } from '@/app/api/agent/projects/[id]/route'
import { PUT as orderPUT } from '@/app/api/agent/projects/order/route'
import { POST as notePOST } from '@/app/api/agent/projects/[id]/notes/route'
import { POST as signPOST } from '@/app/api/agent/projects/[id]/files/sign/route'
import { POST as filePOST } from '@/app/api/agent/projects/[id]/files/route'
import { DELETE as itemDELETE, GET as itemGET } from '@/app/api/agent/projects/[id]/files/[fileId]/route'
import { PUT as movePUT } from '@/app/api/agent/conversations/[id]/project/route'

const PID = '0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c'
const PID2 = '1f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c'
const CID = '2f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c'
const FID = '3f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c'
const VID = '4f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c'
const project = { id: PID, name: 'Roofers', instructions: '', vertical_id: null, position: 0, created_at: 'x', updated_at: 'x' }

const req = (method = 'GET', body?: unknown, url = 'http://localhost/api/agent/projects') =>
  new Request(url, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
const ctx = (id = PID) => ({ params: Promise.resolve({ id }) })
const fctx = (id = PID, fileId = FID) => ({ params: Promise.resolve({ id, fileId }) })

beforeEach(() => {
  vi.clearAllMocks()
  process.env.LUME_INTERNAL_SECRET = 'test-secret'
  h.requireOwner.mockResolvedValue({ ok: true, via: 'session', user: {} })
  h.getProject.mockImplementation(async (id: string) => (id === PID ? project : null))
  h.projectBytes.mockResolvedValue(0)
  h.itemByStoragePath.mockResolvedValue(null)
  h.currentOperator.mockResolvedValue(null)
  h.removeProjectObjects.mockResolvedValue(true)
  h.recordPendingUpload.mockResolvedValue(undefined)
  h.clearPendingUpload.mockResolvedValue(undefined)
  h.getVertical.mockResolvedValue({ id: VID, name: 'Roofers' })
})

describe('auth', () => {
  it('every handler goes through requireOwner (session or the internal bearer)', async () => {
    h.requireOwner.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'unauthenticated' }, { status: 401 }) })
    const all = [
      listGET(req()),
      createPOST(req('POST', { name: 'x' })),
      projectGET(req(), ctx()),
      projectPATCH(req('PATCH', { name: 'x' }), ctx()),
      projectDELETE(req('DELETE'), ctx()),
      orderPUT(req('PUT', { ids: [PID] })),
      notePOST(req('POST', { content: 'x' }), ctx()),
      signPOST(req('POST', { filename: 'a.csv', size: 1 }), ctx()),
      filePOST(req('POST', {}), ctx()),
      itemGET(req(), fctx()),
      itemDELETE(req('DELETE'), fctx()),
      movePUT(req('PUT', { project_id: null }), ctx(CID)),
    ]
    for (const r of await Promise.all(all)) expect(r.status).toBe(401)
    expect(h.listProjects).not.toHaveBeenCalled()
    expect(h.moveConversation).not.toHaveBeenCalled()
  })
})

describe('/api/agent/projects', () => {
  it('GET lists projects', async () => {
    h.listProjects.mockResolvedValue([{ ...project, item_count: 2, total_bytes: 10 }])
    expect(await (await listGET(req())).json()).toEqual({ projects: [{ ...project, item_count: 2, total_bytes: 10 }] })
  })

  it('POST creates (201); a bad body is 400; a taken name or vertical is 409', async () => {
    h.createProject.mockResolvedValue(project)
    const ok = await createPOST(req('POST', { name: ' Roofers ', vertical_id: VID }))
    expect(ok.status).toBe(201)
    expect(h.createProject).toHaveBeenCalledWith({ name: 'Roofers', vertical_id: VID })
    expect((await createPOST(req('POST', { name: '' }))).status).toBe(400)
    expect((await createPOST(req('POST', { name: 'x', extra: 1 }))).status).toBe(400)
    h.createProject.mockRejectedValue(new ProjectConflictError('vertical_taken'))
    const taken = await createPOST(req('POST', { name: 'x', vertical_id: VID }))
    expect(taken.status).toBe(409)
    expect(await taken.json()).toEqual({ error: 'vertical_taken' })
  })

  it('POST with an unknown vertical is 400', async () => {
    h.getVertical.mockResolvedValue(null)
    expect((await createPOST(req('POST', { name: 'x', vertical_id: VID }))).status).toBe(400)
    expect(h.createProject).not.toHaveBeenCalled()
  })
})

describe('/api/agent/projects/[id]', () => {
  it('GET returns the project, its items and its chats; 404 when missing', async () => {
    h.listItems.mockResolvedValue([{ id: FID }])
    h.projectConversations.mockResolvedValue([{ id: CID }])
    expect(await (await projectGET(req(), ctx())).json()).toEqual({ project, items: [{ id: FID }], conversations: [{ id: CID }] })
    expect((await projectGET(req(), ctx(PID2))).status).toBe(404)
    expect((await projectGET(req(), ctx('nope'))).status).toBe(400)
  })

  it('PATCH saves instructions / links a vertical; 404 when missing', async () => {
    h.updateProject.mockResolvedValue({ ...project, instructions: 'Tone: casual' })
    const res = await projectPATCH(req('PATCH', { instructions: 'Tone: casual' }), ctx())
    expect(res.status).toBe(200)
    expect(h.updateProject).toHaveBeenCalledWith(PID, { instructions: 'Tone: casual' })
    await projectPATCH(req('PATCH', { vertical_id: null }), ctx())
    expect(h.updateProject).toHaveBeenLastCalledWith(PID, { vertical_id: null })
    expect((await projectPATCH(req('PATCH', {}), ctx())).status).toBe(400)
    h.updateProject.mockResolvedValue(null)
    expect((await projectPATCH(req('PATCH', { name: 'x' }), ctx())).status).toBe(404)
  })

  it('DELETE removes the project and its stored files', async () => {
    h.deleteProject.mockResolvedValue([`${PID}/a.csv`])
    const res = await projectDELETE(req('DELETE'), ctx())
    expect(res.status).toBe(200)
    expect(h.removeProjectObjects).toHaveBeenCalledWith([`${PID}/a.csv`])
    h.deleteProject.mockResolvedValue(null)
    expect((await projectDELETE(req('DELETE'), ctx())).status).toBe(404)
  })
})

describe('reorder and move', () => {
  it('PUT /order sets positions in the given order', async () => {
    h.reorderProjects.mockResolvedValue(2)
    const res = await orderPUT(req('PUT', { ids: [PID2, PID] }))
    expect(res.status).toBe(200)
    expect(h.reorderProjects).toHaveBeenCalledWith([PID2, PID])
    expect((await orderPUT(req('PUT', { ids: [PID, PID] }))).status).toBe(400)
    expect((await orderPUT(req('PUT', { ids: [] }))).status).toBe(400)
  })

  it('PUT /conversations/[id]/project files a chat; null unfiles it', async () => {
    h.moveConversation.mockResolvedValue(true)
    const res = await movePUT(req('PUT', { project_id: PID }), ctx(CID))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, project_id: PID })
    expect(h.moveConversation).toHaveBeenCalledWith(CID, PID)
    await movePUT(req('PUT', { project_id: null }), ctx(CID))
    expect(h.moveConversation).toHaveBeenLastCalledWith(CID, null)
  })

  it('moving into a missing project is 404 project_not_found; a missing chat is 404', async () => {
    const res = await movePUT(req('PUT', { project_id: PID2 }), ctx(CID))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'project_not_found' })
    expect(h.moveConversation).not.toHaveBeenCalled()
    h.moveConversation.mockResolvedValue(false)
    expect((await movePUT(req('PUT', { project_id: null }), ctx(CID))).status).toBe(404)
  })
})

describe('notes', () => {
  it('POST adds a note named from its first line', async () => {
    h.addNote.mockResolvedValue({ id: FID })
    const res = await notePOST(req('POST', { content: 'Never order more than 2k\nsecond line' }), ctx())
    expect(res.status).toBe(201)
    expect(h.addNote).toHaveBeenCalledWith(PID, 'Never order more than 2k', 'Never order more than 2k\nsecond line')
    expect((await notePOST(req('POST', { content: 'x' }), ctx(PID2))).status).toBe(404)
  })
})

describe('file upload', () => {
  it('sign: unsupported types 415, over 20 MB 413, project over 200 MB 413', async () => {
    expect((await signPOST(req('POST', { filename: 'a.exe', size: 10 }), ctx())).status).toBe(415)
    expect((await signPOST(req('POST', { filename: 'a.csv', size: 20 * 1024 * 1024 + 1 }), ctx())).status).toBe(413)
    h.projectBytes.mockResolvedValue(200 * 1024 * 1024 - 5)
    const full = await signPOST(req('POST', { filename: 'a.csv', size: 10 }), ctx())
    expect(full.status).toBe(413)
    expect(await full.json()).toEqual({ error: 'project_full' })
  })

  it('sign returns a path under the project and a ticket', async () => {
    h.signProjectUpload.mockResolvedValue({ token: 'tok', signedUrl: 'https://s' })
    const res = await signPOST(req('POST', { filename: 'Leads.CSV', size: 10 }), ctx())
    const body = await res.json()
    expect(body.path).toMatch(new RegExp(`^${PID}/[0-9a-f-]{36}\\.csv$`))
    expect(body.token).toBe('tok')
    expect(body.upload_ticket).toMatch(/^\d+\.[0-9a-f]{64}$/)
  })

  async function signed(filename = 'leads.csv') {
    h.signProjectUpload.mockResolvedValue({ token: 'tok', signedUrl: 'https://s' })
    return (await (await signPOST(req('POST', { filename, size: 10 }), ctx())).json()) as { path: string; upload_ticket: string }
  }

  it('finalize: extracts the text and stores the item', async () => {
    const { path, upload_ticket } = await signed()
    h.downloadProjectObject.mockResolvedValue(new TextEncoder().encode('email\na@b.co'))
    h.extractText.mockResolvedValue({ text: 'email\na@b.co', readable: true, truncated: false })
    h.addFile.mockResolvedValue({ id: FID, name: 'leads.csv' })
    const res = await filePOST(req('POST', { storage_path: path, filename: 'leads.csv', upload_ticket }), ctx())
    expect(res.status).toBe(201)
    expect(h.extractText).toHaveBeenCalledWith(expect.any(Uint8Array), 'csv')
    expect(h.addFile).toHaveBeenCalledWith({
      project_id: PID, name: 'leads.csv', mime: 'text/csv', size_bytes: 12, storage_path: path,
      text_content: 'email\na@b.co', readable: true, truncated: false,
    })
  })

  it('finalize: an unreadable file is still stored, marked not readable', async () => {
    const { path, upload_ticket } = await signed('scan.pdf')
    h.downloadProjectObject.mockResolvedValue(new Uint8Array([1, 2, 3]))
    h.extractText.mockResolvedValue({ text: null, readable: false, truncated: false })
    h.addFile.mockResolvedValue({ id: FID, readable: false })
    expect((await filePOST(req('POST', { storage_path: path, filename: 'scan.pdf', upload_ticket }), ctx())).status).toBe(201)
    expect(h.addFile.mock.calls[0][0]).toMatchObject({ readable: false, text_content: null, mime: 'application/pdf' })
  })

  it('finalize: a bad ticket is 403, another project\'s path is 400, a missing upload 404, a replay 409', async () => {
    const { path, upload_ticket } = await signed()
    expect((await filePOST(req('POST', { storage_path: path, filename: 'leads.csv', upload_ticket: '1.' + 'a'.repeat(64) }), ctx())).status).toBe(403)
    expect((await filePOST(req('POST', { storage_path: path.replace(PID, PID2), filename: 'leads.csv', upload_ticket }), ctx())).status).toBe(400)
    h.downloadProjectObject.mockResolvedValue(null)
    expect((await filePOST(req('POST', { storage_path: path, filename: 'leads.csv', upload_ticket }), ctx())).status).toBe(404)
    h.itemByStoragePath.mockResolvedValue({ id: FID })
    expect((await filePOST(req('POST', { storage_path: path, filename: 'leads.csv', upload_ticket }), ctx())).status).toBe(409)
  })

  it('finalize: over the project cap is 413 and the object is removed', async () => {
    const { path, upload_ticket } = await signed()
    h.downloadProjectObject.mockResolvedValue(new Uint8Array(100))
    h.projectBytes.mockResolvedValue(200 * 1024 * 1024 - 50)
    const res = await filePOST(req('POST', { storage_path: path, filename: 'leads.csv', upload_ticket }), ctx())
    expect(res.status).toBe(413)
    expect(h.removeProjectObjects).toHaveBeenCalledWith([path])
    expect(h.addFile).not.toHaveBeenCalled()
  })
})

describe('/api/agent/projects/[id]/files/[fileId]', () => {
  it('GET reads a window of the text, scoped to the project', async () => {
    h.getItemText.mockResolvedValue({ id: FID, name: 'big.txt', kind: 'file', readable: true, text_content: 'abcdef' })
    const res = await itemGET(req('GET', undefined, `http://localhost/x?offset=2`), fctx())
    expect(h.getItemText).toHaveBeenCalledWith(PID, FID)
    expect(await res.json()).toMatchObject({ id: FID, name: 'big.txt', text: 'cdef', offset: 2, next_offset: null, total_chars: 6 })
  })

  it("another project's file id is 404 (the lookup is scoped)", async () => {
    h.getItemText.mockResolvedValue(null)
    expect((await itemGET(req(), fctx(PID, FID))).status).toBe(404)
  })

  it('an unreadable file says so', async () => {
    h.getItemText.mockResolvedValue({ id: FID, name: 'scan.pdf', kind: 'file', readable: false, text_content: null })
    expect(await (await itemGET(req(), fctx())).json()).toMatchObject({ readable: false, text: '' })
  })

  it('DELETE removes the item and its object', async () => {
    h.deleteItem.mockResolvedValue({ storage_path: `${PID}/x.csv` })
    expect((await itemDELETE(req('DELETE'), fctx())).status).toBe(200)
    expect(h.deleteItem).toHaveBeenCalledWith(PID, FID)
    expect(h.removeProjectObjects).toHaveBeenCalledWith([`${PID}/x.csv`])
    h.deleteItem.mockResolvedValue(null)
    expect((await itemDELETE(req('DELETE'), fctx())).status).toBe(404)
  })
})

describe('pending uploads and cleanup', () => {
  async function signed(filename = 'leads.csv') {
    h.signProjectUpload.mockResolvedValue({ token: 'tok', signedUrl: 'https://s' })
    return (await (await signPOST(req('POST', { filename, size: 10 }), ctx())).json()) as { path: string; upload_ticket: string }
  }

  it('sign records the path as pending before the object can exist', async () => {
    const { path } = await signed()
    expect(h.recordPendingUpload).toHaveBeenCalledWith(path, PID)
    expect(h.recordPendingUpload.mock.invocationCallOrder[0]).toBeLessThan(h.signProjectUpload.mock.invocationCallOrder[0])
  })

  it('a successful finalize clears the pending row and keeps the object', async () => {
    const { path, upload_ticket } = await signed()
    h.downloadProjectObject.mockResolvedValue(new Uint8Array(3))
    h.extractText.mockResolvedValue({ text: 'a', readable: true, truncated: false })
    h.addFile.mockResolvedValue({ id: FID })
    expect((await filePOST(req('POST', { storage_path: path, filename: 'leads.csv', upload_ticket }), ctx())).status).toBe(201)
    expect(h.clearPendingUpload).toHaveBeenCalledWith(path)
    expect(h.removeProjectObjects).not.toHaveBeenCalled()
  })

  it('a finalize that fails (store error) removes the object and the pending row', async () => {
    const { path, upload_ticket } = await signed()
    h.downloadProjectObject.mockResolvedValue(new Uint8Array(3))
    h.extractText.mockResolvedValue({ text: null, readable: false, truncated: false })
    h.addFile.mockRejectedValue(new Error('db down'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await filePOST(req('POST', { storage_path: path, filename: 'leads.csv', upload_ticket }), ctx())).status).toBe(500)
    expect(h.removeProjectObjects).toHaveBeenCalledWith([path])
    expect(h.clearPendingUpload).toHaveBeenCalledWith(path)
  })

  it('a finalize whose download throws also cleans up', async () => {
    const { path, upload_ticket } = await signed()
    h.downloadProjectObject.mockRejectedValue(new Error('storage 503'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await filePOST(req('POST', { storage_path: path, filename: 'leads.csv', upload_ticket }), ctx())).status).toBe(500)
    expect(h.removeProjectObjects).toHaveBeenCalledWith([path])
  })

  it('a replay (item already there) keeps its object', async () => {
    const { path, upload_ticket } = await signed()
    h.itemByStoragePath.mockResolvedValue({ id: FID })
    expect((await filePOST(req('POST', { storage_path: path, filename: 'leads.csv', upload_ticket }), ctx())).status).toBe(409)
    expect(h.removeProjectObjects).not.toHaveBeenCalled()
  })

  it('a finalize whose name does not match the signed type is 415 and cleaned up', async () => {
    const { path, upload_ticket } = await signed()
    expect((await filePOST(req('POST', { storage_path: path, filename: 'leads.pdf', upload_ticket }), ctx())).status).toBe(415)
    expect(h.removeProjectObjects).toHaveBeenCalledWith([path])
  })

  it("a CSV import ticket is not accepted (purpose-bound HMAC)", async () => {
    const { uploadTicket } = await import('@/lib/import/ticket')
    const { path } = await signed()
    expect((await filePOST(req('POST', { storage_path: path, filename: 'leads.csv', upload_ticket: uploadTicket(path) }), ctx())).status).toBe(403)
  })
})

describe('the delete race', () => {
  it('a note or a move into a project deleted meanwhile is 404, not 500', async () => {
    h.addNote.mockRejectedValue(new ProjectGoneError())
    const res = await notePOST(req('POST', { content: 'x' }), ctx())
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'project_not_found' })
    h.moveConversation.mockRejectedValue(new ProjectGoneError())
    expect((await movePUT(req('PUT', { project_id: PID }), ctx(CID))).status).toBe(404)
  })

  it('finalize into a project deleted meanwhile is 404 and the object goes', async () => {
    h.signProjectUpload.mockResolvedValue({ token: 'tok', signedUrl: 'https://s' })
    const { path, upload_ticket } = (await (await signPOST(req('POST', { filename: 'a.csv', size: 1 }), ctx())).json()) as { path: string; upload_ticket: string }
    h.downloadProjectObject.mockResolvedValue(new Uint8Array(1))
    h.extractText.mockResolvedValue({ text: 'a', readable: true, truncated: false })
    h.addFile.mockRejectedValue(new ProjectGoneError())
    expect((await filePOST(req('POST', { storage_path: path, filename: 'a.csv', upload_ticket }), ctx())).status).toBe(404)
    expect(h.removeProjectObjects).toHaveBeenCalledWith([path])
  })
})

describe('vertical Grok Bot scope', () => {
  const OWN = '5f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c'
  const OTHER = '6f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c'
  const own = { ...project, id: PID, vertical_id: OWN }
  const theirs = { ...project, id: PID2, name: 'Theirs', vertical_id: OTHER }
  const unlinked = { ...project, id: FID, name: 'Shared', vertical_id: null }
  beforeEach(() => {
    h.currentOperator.mockResolvedValue({ id: 'op-1', vertical_id: OWN, is_master: false, label: 'bot', revoked_at: null })
    h.getProject.mockImplementation(async (id: string) => [own, theirs, unlinked].find((p) => p.id === id) ?? null)
    h.listProjects.mockResolvedValue([own, theirs, unlinked].map((p) => ({ ...p, item_count: 0, total_bytes: 0 })))
  })

  it("lists only its own vertical's project and unlinked ones", async () => {
    const body = await (await listGET(req())).json()
    expect(body.projects.map((p: { id: string }) => p.id)).toEqual([PID, FID])
  })

  it("another vertical's project is 403 on every route; its own and unlinked are fine", async () => {
    h.listItems.mockResolvedValue([])
    h.projectConversations.mockResolvedValue([])
    expect((await projectGET(req(), ctx(PID2))).status).toBe(403)
    expect((await projectPATCH(req('PATCH', { instructions: 'x' }), ctx(PID2))).status).toBe(403)
    expect((await projectDELETE(req('DELETE'), ctx(PID2))).status).toBe(403)
    expect((await notePOST(req('POST', { content: 'x' }), ctx(PID2))).status).toBe(403)
    expect((await signPOST(req('POST', { filename: 'a.csv', size: 1 }), ctx(PID2))).status).toBe(403)
    expect((await itemGET(req(), fctx(PID2))).status).toBe(403)
    expect((await itemDELETE(req('DELETE'), fctx(PID2))).status).toBe(403)
    expect(h.updateProject).not.toHaveBeenCalled()
    expect(h.deleteProject).not.toHaveBeenCalled()
    expect(h.getItemText).not.toHaveBeenCalled()
    expect((await projectGET(req(), ctx(PID))).status).toBe(200)
    expect((await projectGET(req(), ctx(FID))).status).toBe(200)
  })

  it('cannot link a project to another vertical; may link to its own or unlink', async () => {
    expect((await createPOST(req('POST', { name: 'x', vertical_id: OTHER }))).status).toBe(403)
    expect((await projectPATCH(req('PATCH', { vertical_id: OTHER }), ctx(FID))).status).toBe(403)
    h.updateProject.mockResolvedValue(own)
    expect((await projectPATCH(req('PATCH', { vertical_id: null }), ctx(PID))).status).toBe(200)
  })

  it("cannot reorder another vertical's project", async () => {
    expect((await orderPUT(req('PUT', { ids: [PID2, PID] }))).status).toBe(403)
    h.reorderProjects.mockResolvedValue(2)
    expect((await orderPUT(req('PUT', { ids: [FID, PID] }))).status).toBe(200)
  })

  it("cannot move a chat into, or out of, another vertical's project", async () => {
    h.moveConversation.mockResolvedValue(true)
    expect((await movePUT(req('PUT', { project_id: PID2 }), ctx(CID))).status).toBe(403)
    h.getConversation.mockResolvedValue({ id: CID, title: 't', created_at: '', updated_at: '', project_id: PID2 })
    expect((await movePUT(req('PUT', { project_id: null }), ctx(CID))).status).toBe(403)
    h.getConversation.mockResolvedValue({ id: CID, title: 't', created_at: '', updated_at: '', project_id: null })
    expect((await movePUT(req('PUT', { project_id: PID }), ctx(CID))).status).toBe(200)
  })

  it('the master bot and the internal bearer are unscoped', async () => {
    h.currentOperator.mockResolvedValue({ id: 'op-m', vertical_id: null, is_master: true, label: 'Master', revoked_at: null })
    h.listItems.mockResolvedValue([])
    h.projectConversations.mockResolvedValue([])
    expect((await projectGET(req(), ctx(PID2))).status).toBe(200)
    h.currentOperator.mockResolvedValue({ id: 'op-1', vertical_id: OWN, is_master: false, label: 'bot', revoked_at: null })
    h.requireOwner.mockResolvedValue({ ok: true, via: 'internal', user: null })
    expect((await projectGET(req(), ctx(PID2))).status).toBe(200)
  })
})

describe('/api/cron/project-uploads', () => {
  const sweep = (secret = 'hook') => sweepPOST(new Request('http://localhost/api/cron/project-uploads', { method: 'POST', headers: { 'X-Lume-Hook-Secret': secret } }))
  beforeEach(() => {
    process.env.LUME_HOOK_SECRET = 'hook'
  })

  it('needs the hook secret', async () => {
    expect((await sweep('wrong')).status).toBe(401)
    expect(h.stalePendingUploads).not.toHaveBeenCalled()
  })

  it('removes objects of uploads signed over 3 hours ago and never finalized; keeps finalized ones', async () => {
    h.stalePendingUploads.mockResolvedValue(['p/a.csv', 'p/b.pdf'])
    h.pathsInUse.mockResolvedValue(new Set(['p/b.pdf']))
    const res = await sweep()
    expect(await res.json()).toEqual({ ok: true, removed: 1, kept: 1 })
    const cutoff = h.stalePendingUploads.mock.calls[0][0] as Date
    // Signed upload URLs stay valid for 2 h: only rows older than that can be orphans.
    expect(Date.now() - cutoff.getTime()).toBeGreaterThan(2 * 60 * 60 * 1000)
    expect(h.removeProjectObjects).toHaveBeenCalledWith(['p/a.csv'])
    expect(h.deletePendingUploads).toHaveBeenCalledWith(['p/a.csv', 'p/b.pdf'])
  })

  it('a failed Storage delete keeps the orphan rows for the next run', async () => {
    h.stalePendingUploads.mockResolvedValue(['p/a.csv', 'p/b.pdf'])
    h.pathsInUse.mockResolvedValue(new Set(['p/b.pdf']))
    h.removeProjectObjects.mockResolvedValue(false)
    const res = await sweep()
    expect(res.status).toBe(502)
    expect(h.deletePendingUploads).toHaveBeenCalledWith(['p/b.pdf'])
  })
})
