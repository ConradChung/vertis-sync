import { beforeEach, describe, expect, it, vi } from 'vitest'

const projects = vi.hoisted(() => ({
  projectForVertical: vi.fn(),
  createProject: vi.fn(),
  listItems: vi.fn(),
  addNote: vi.fn(),
  ProjectConflictError: class ProjectConflictError extends Error {
    constructor(readonly code: 'name_taken' | 'vertical_taken') {
      super(code)
    }
  },
}))
vi.mock('@/lib/agent/projects', () => projects)
const ops = vi.hoisted(() => ({ getVertical: vi.fn() }))
vi.mock('@/lib/operators/store', () => ops)

import { createInboxProject } from '@/lib/inbox/seedProject'
import { INBOX_NOTE_NAMES } from '@/lib/inbox/templates'

const V = { id: 'v-1', name: 'Roofers', campaign_ids: [], scopes: [], is_default: false, created_at: '', archived_at: null }

beforeEach(() => {
  vi.resetAllMocks()
  ops.getVertical.mockResolvedValue(V)
  projects.listItems.mockResolvedValue([])
  projects.addNote.mockImplementation(async (_p: string, name: string) => ({ id: `n-${name}`, name }))
})

describe('createInboxProject', () => {
  it('creates "<vertical> · Inbox" linked to the vertical and seeds the five notes', async () => {
    projects.projectForVertical.mockResolvedValue(null)
    projects.createProject.mockResolvedValue({ id: 'p-1', name: 'Roofers · Inbox', vertical_id: 'v-1' })
    const out = await createInboxProject('v-1')
    expect(projects.createProject).toHaveBeenCalledWith(expect.objectContaining({ name: 'Roofers · Inbox', vertical_id: 'v-1' }))
    expect(out).toMatchObject({ ok: true, created_project: true, project: { id: 'p-1', name: 'Roofers · Inbox' }, seeded: INBOX_NOTE_NAMES, kept: [] })
    expect(projects.addNote).toHaveBeenCalledTimes(5)
    for (const c of projects.addNote.mock.calls) expect(c[0]).toBe('p-1')
  })

  it('is idempotent: a re-run on the linked Inbox project adds only missing notes, never overwrites', async () => {
    projects.projectForVertical.mockResolvedValue({ id: 'p-1', name: 'Roofers · Inbox' })
    projects.listItems.mockResolvedValue([{ name: 'qualify-rules.md' }, { name: 'VOICE-RULES.md' }])
    const out = await createInboxProject('v-1')
    expect(projects.createProject).not.toHaveBeenCalled()
    expect(out).toMatchObject({ ok: true, created_project: false, seeded: ['voice-samples.md', 'reply-templates.md', 'settings.md'], kept: ['qualify-rules.md', 'voice-rules.md'] })
  })

  it('reports the conflict when the vertical already has another linked project, and writes nothing', async () => {
    projects.projectForVertical.mockResolvedValue({ id: 'p-9', name: 'Roofers research' })
    const out = await createInboxProject('v-1')
    expect(out).toEqual({ ok: false, error: 'vertical_has_project', project: { id: 'p-9', name: 'Roofers research' } })
    expect(projects.addNote).not.toHaveBeenCalled()
    expect(projects.createProject).not.toHaveBeenCalled()
  })

  it('reports a name taken by an unlinked or other project', async () => {
    projects.projectForVertical.mockResolvedValue(null)
    projects.createProject.mockRejectedValue(new projects.ProjectConflictError('name_taken'))
    expect(await createInboxProject('v-1')).toEqual({ ok: false, error: 'name_taken', name: 'Roofers · Inbox' })
  })

  it('a concurrent create that linked the same project first is reused', async () => {
    projects.projectForVertical.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'p-2', name: 'Roofers · Inbox' })
    projects.createProject.mockRejectedValue(new projects.ProjectConflictError('vertical_taken'))
    const out = await createInboxProject('v-1')
    expect(out).toMatchObject({ ok: true, created_project: false, project: { id: 'p-2' } })
  })

  it('a missing or archived vertical is not found', async () => {
    ops.getVertical.mockResolvedValue(null)
    expect(await createInboxProject('v-1')).toEqual({ ok: false, error: 'vertical_not_found' })
    ops.getVertical.mockResolvedValue({ ...V, archived_at: '2026-10-01' })
    expect(await createInboxProject('v-1')).toEqual({ ok: false, error: 'vertical_not_found' })
  })
})
