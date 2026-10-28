import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { DbError } from '@/lib/db/service'
import type { ConversationSummary } from '@/lib/agent/history'
import { BLOCK_BUDGET, type Project, type ProjectItem, type ProjectItemText, type ProjectSummary } from '@/lib/agent/projectModel'

/**
 * `agent_projects` / `agent_project_files` and filing conversations
 * (service role, behind the owner guard). Files' bytes live in the private
 * `agent-projects` bucket (lib/agent/projectStorage.ts).
 */

const PROJECT_COLS = 'id, name, instructions, vertical_id, position, created_at, updated_at'
const ITEM_COLS = 'id, kind, name, mime, size_bytes, readable, truncated, text_chars, created_at'

/** A live project's name or vertical link is taken (unique index). */
export class ProjectConflictError extends Error {
  constructor(readonly code: 'name_taken' | 'vertical_taken') {
    super(code)
    this.name = 'ProjectConflictError'
  }
}

type PgErr = { code?: string; message?: string; details?: string } | null

function conflict(err: PgErr): ProjectConflictError | null {
  if (err?.code !== '23505') return null
  const text = `${err.message ?? ''} ${err.details ?? ''}`
  return new ProjectConflictError(text.includes('vertical') ? 'vertical_taken' : 'name_taken')
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const sb = createServiceClient()
  const res = await sb.from('agent_projects').select(PROJECT_COLS).is('archived_at', null).order('position').order('created_at').limit(500)
  if (res.error) throw new DbError('listProjects', res.error)
  const projects = (res.data ?? []) as Project[]
  if (!projects.length) return []
  const files = await sb.from('agent_project_files').select('project_id, size_bytes').in('project_id', projects.map((p) => p.id))
  if (files.error) throw new DbError('listProjects.files', files.error)
  const totals = new Map<string, { n: number; bytes: number }>()
  for (const f of (files.data ?? []) as { project_id: string; size_bytes: number }[]) {
    const t = totals.get(f.project_id) ?? { n: 0, bytes: 0 }
    t.n++
    t.bytes += Number(f.size_bytes) || 0
    totals.set(f.project_id, t)
  }
  return projects.map((p) => ({ ...p, item_count: totals.get(p.id)?.n ?? 0, total_bytes: totals.get(p.id)?.bytes ?? 0 }))
}

/** A live project, or null. */
export async function getProject(id: string): Promise<Project | null> {
  const res = await createServiceClient().from('agent_projects').select(PROJECT_COLS).eq('id', id).is('archived_at', null).maybeSingle()
  if (res.error) throw new DbError('getProject', res.error)
  return (res.data as Project | null) ?? null
}

/** The live project linked to a vertical, or null. */
export async function projectForVertical(verticalId: string): Promise<Pick<Project, 'id' | 'name'> | null> {
  const res = await createServiceClient()
    .from('agent_projects')
    .select('id, name')
    .eq('vertical_id', verticalId)
    .is('archived_at', null)
    .maybeSingle()
  if (res.error) throw new DbError('projectForVertical', res.error)
  return (res.data as Pick<Project, 'id' | 'name'> | null) ?? null
}

/** Created last in the sidebar order. Throws ProjectConflictError on a taken name or vertical. */
export async function createProject(input: { name: string; instructions?: string; vertical_id?: string | null }): Promise<Project> {
  const sb = createServiceClient()
  const last = await sb.from('agent_projects').select('position').is('archived_at', null).order('position', { ascending: false }).limit(1).maybeSingle()
  if (last.error) throw new DbError('createProject.position', last.error)
  const position = ((last.data as { position: number } | null)?.position ?? -1) + 1
  const res = await sb
    .from('agent_projects')
    .insert({ name: input.name, instructions: input.instructions ?? '', vertical_id: input.vertical_id ?? null, position })
    .select(PROJECT_COLS)
    .single()
  const c = conflict(res.error)
  if (c) throw c
  if (res.error || !res.data) throw new DbError('createProject', res.error ?? new Error('no data'))
  return res.data as Project
}

/** null when the project is missing or archived. Throws ProjectConflictError. */
export async function updateProject(
  id: string,
  patch: { name?: string; instructions?: string; vertical_id?: string | null }
): Promise<Project | null> {
  const res = await createServiceClient()
    .from('agent_projects')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .is('archived_at', null)
    .select(PROJECT_COLS)
    .maybeSingle()
  const c = conflict(res.error)
  if (c) throw c
  if (res.error) throw new DbError('updateProject', res.error)
  return (res.data as Project | null) ?? null
}

/**
 * Hard delete: its files and notes go with it (cascade), its chats move to
 * Unfiled (`on delete set null`). Returns the storage paths to remove, or
 * null when the project was not there.
 */
export async function deleteProject(id: string): Promise<string[] | null> {
  const sb = createServiceClient()
  const files = await sb.from('agent_project_files').select('storage_path').eq('project_id', id).not('storage_path', 'is', null)
  if (files.error) throw new DbError('deleteProject.files', files.error)
  const res = await sb.from('agent_projects').delete().eq('id', id).select('id')
  if (res.error) throw new DbError('deleteProject', res.error)
  if (!(res.data ?? []).length) return null
  return ((files.data ?? []) as { storage_path: string }[]).map((f) => f.storage_path)
}

/** Sidebar order: `ids[i]` gets position i. Returns how many live projects were updated. */
export async function reorderProjects(ids: string[]): Promise<number> {
  const sb = createServiceClient()
  const results = await Promise.all(
    ids.map((id, position) => sb.from('agent_projects').update({ position }).eq('id', id).is('archived_at', null).select('id'))
  )
  let n = 0
  for (const r of results) {
    if (r.error) throw new DbError('reorderProjects', r.error)
    n += (r.data ?? []).length
  }
  return n
}

export async function listItems(projectId: string): Promise<ProjectItem[]> {
  const res = await createServiceClient()
    .from('agent_project_files')
    .select(ITEM_COLS)
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(1000)
  if (res.error) throw new DbError('listItems', res.error)
  return (res.data ?? []) as ProjectItem[]
}

/**
 * Items for the Project block: every item, with text only for those small
 * enough to be inlined (the rest are read on demand). Scoped to one project.
 */
export async function itemsForBlock(projectId: string): Promise<ProjectItemText[]> {
  const sb = createServiceClient()
  const items = await listItems(projectId)
  const small = items.filter((i) => i.readable && (i.text_chars ?? 0) > 0 && (i.text_chars ?? 0) <= BLOCK_BUDGET).map((i) => i.id)
  if (!small.length) return items.map((i) => ({ ...i, text_content: null }))
  const texts = await sb.from('agent_project_files').select('id, text_content').eq('project_id', projectId).in('id', small)
  if (texts.error) throw new DbError('itemsForBlock', texts.error)
  const byId = new Map(((texts.data ?? []) as { id: string; text_content: string | null }[]).map((t) => [t.id, t.text_content]))
  return items.map((i) => ({ ...i, text_content: byId.get(i.id) ?? null }))
}

/** One item with its text, only when it belongs to `projectId`. */
export async function getItemText(projectId: string, itemId: string): Promise<ProjectItemText | null> {
  const res = await createServiceClient()
    .from('agent_project_files')
    .select(`${ITEM_COLS}, text_content`)
    .eq('id', itemId)
    .eq('project_id', projectId)
    .maybeSingle()
  if (res.error) throw new DbError('getItemText', res.error)
  return (res.data as ProjectItemText | null) ?? null
}

/** Total stored bytes in a project (the 200 MB cap). */
export async function projectBytes(projectId: string): Promise<number> {
  const res = await createServiceClient().from('agent_project_files').select('size_bytes').eq('project_id', projectId)
  if (res.error) throw new DbError('projectBytes', res.error)
  return ((res.data ?? []) as { size_bytes: number }[]).reduce((s, r) => s + (Number(r.size_bytes) || 0), 0)
}

export async function addNote(projectId: string, name: string, content: string): Promise<ProjectItem> {
  const res = await createServiceClient()
    .from('agent_project_files')
    .insert({ project_id: projectId, kind: 'note', name, mime: 'text/plain', size_bytes: new TextEncoder().encode(content).byteLength, text_content: content })
    .select(ITEM_COLS)
    .single()
  if (res.error || !res.data) throw new DbError('addNote', res.error ?? new Error('no data'))
  return res.data as ProjectItem
}

export async function addFile(row: {
  project_id: string
  name: string
  mime: string
  size_bytes: number
  storage_path: string
  text_content: string | null
  readable: boolean
  truncated: boolean
}): Promise<ProjectItem> {
  const res = await createServiceClient()
    .from('agent_project_files')
    .insert({ ...row, kind: 'file' })
    .select(ITEM_COLS)
    .single()
  if (res.error || !res.data) throw new DbError('addFile', res.error ?? new Error('no data'))
  return res.data as ProjectItem
}

/** Is an upload already recorded (a finalize replay)? */
export async function itemByStoragePath(path: string): Promise<{ id: string } | null> {
  const res = await createServiceClient().from('agent_project_files').select('id').eq('storage_path', path).maybeSingle()
  if (res.error) throw new DbError('itemByStoragePath', res.error)
  return (res.data as { id: string } | null) ?? null
}

/** Removes one item of `projectId`: `{ storage_path }` (null for a note), or null when it was not there. */
export async function deleteItem(projectId: string, itemId: string): Promise<{ storage_path: string | null } | null> {
  const res = await createServiceClient().from('agent_project_files').delete().eq('id', itemId).eq('project_id', projectId).select('storage_path')
  if (res.error) throw new DbError('deleteItem', res.error)
  const row = (res.data ?? [])[0] as { storage_path: string | null } | undefined
  return row ?? null
}

/** File (or unfile, with null) a live conversation. false when the conversation is missing or archived. */
export async function moveConversation(conversationId: string, projectId: string | null): Promise<boolean> {
  const res = await createServiceClient()
    .from('agent_conversations')
    .update({ project_id: projectId })
    .eq('id', conversationId)
    .is('archived_at', null)
    .select('id')
  if (res.error) throw new DbError('moveConversation', res.error)
  return (res.data ?? []).length > 0
}

export async function projectConversations(projectId: string, limit = 200): Promise<ConversationSummary[]> {
  const res = await createServiceClient()
    .from('agent_conversations')
    .select('id, title, created_at, updated_at, project_id')
    .eq('project_id', projectId)
    .is('archived_at', null)
    .order('updated_at', { ascending: false })
    .limit(limit)
  if (res.error) throw new DbError('projectConversations', res.error)
  return (res.data ?? []) as ConversationSummary[]
}
