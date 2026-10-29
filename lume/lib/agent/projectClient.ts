/**
 * Browser-side calls for agent projects, plus the drag-and-drop payload
 * types. Never throws: a failure is `{ ok: false, error }` with a message
 * fit to show.
 */
import { createClient } from '@/lib/supabase/client'
import { fileTypeOf, MAX_FILE_BYTES, type Project, type ProjectItem } from '@/lib/agent/projectModel'

/** dataTransfer types for in-app drags (OS files arrive as 'Files'). */
export const CHAT_DRAG = 'application/x-lume-chat'
export const PROJECT_DRAG = 'application/x-lume-project'

export type DragKind = 'chat' | 'project' | 'files' | null

/** What is being dragged, from `dataTransfer.types` (readable during dragover, unlike the data). */
export function dragKind(dt: Pick<DataTransfer, 'types'> | null | undefined): DragKind {
  const types = Array.from(dt?.types ?? [])
  if (types.includes(CHAT_DRAG)) return 'chat'
  if (types.includes(PROJECT_DRAG)) return 'project'
  if (types.includes('Files')) return 'files'
  return null
}

/** `ids` with `moved` placed before (or after) `target`. Unchanged when either is missing or they are the same. */
export function reorderIds(ids: string[], moved: string, target: string, after = false): string[] {
  if (moved === target || !ids.includes(moved) || !ids.includes(target)) return ids
  const rest = ids.filter((id) => id !== moved)
  const at = rest.indexOf(target) + (after ? 1 : 0)
  return [...rest.slice(0, at), moved, ...rest.slice(at)]
}

/** One place up or down; unchanged at an end. */
export function shiftId(ids: string[], id: string, by: -1 | 1): string[] {
  const i = ids.indexOf(id)
  const j = i + by
  if (i < 0 || j < 0 || j >= ids.length) return ids
  const next = [...ids]
  ;[next[i], next[j]] = [next[j], next[i]]
  return next
}

export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string }

const MESSAGES: Record<string, string> = {
  name_taken: 'A project with that name already exists.',
  vertical_taken: 'That vertical is already linked to another project.',
  vertical_not_found: 'That vertical no longer exists.',
  unsupported_media_type: 'Unsupported file type. Use CSV, PDF, MD, TXT, JSON or an image.',
  too_large: 'Over the 20 MB per-file limit.',
  project_full: "This project is at its 200 MB limit.",
  project_not_found: 'That project no longer exists.',
  not_found: 'Not found — it may have been deleted.',
  invalid_ticket: 'Upload expired — try again.',
  upload_missing: 'The upload did not arrive — try again.',
  storage: 'Could not store the file — try again.',
  invalid_body: 'Check what you entered.',
}

export const errorMessage = (code: string | undefined, status: number) =>
  (code && MESSAGES[code]) || (status === 0 ? 'Network error — try again.' : `Request failed (${status}).`)

async function call<T>(url: string, method: string, body?: unknown): Promise<Result<T>> {
  try {
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const json = (await res.json().catch(() => ({}))) as T & { error?: string }
    if (!res.ok) return { ok: false, error: errorMessage(json?.error, res.status) }
    return { ok: true, ...json }
  } catch {
    return { ok: false, error: errorMessage(undefined, 0) }
  }
}

export const createProject = (name: string) => call<{ project: Project }>('/api/agent/projects', 'POST', { name })
export const patchProject = (id: string, patch: { name?: string; instructions?: string; vertical_id?: string | null }) =>
  call<{ project: Project }>(`/api/agent/projects/${id}`, 'PATCH', patch)
export const deleteProject = (id: string) => call(`/api/agent/projects/${id}`, 'DELETE')
export const saveProjectOrder = (ids: string[]) => call('/api/agent/projects/order', 'PUT', { ids })
export const moveChat = (conversationId: string, projectId: string | null) =>
  call(`/api/agent/conversations/${conversationId}/project`, 'PUT', { project_id: projectId })
export const addNote = (projectId: string, content: string) => call<{ item: ProjectItem }>(`/api/agent/projects/${projectId}/notes`, 'POST', { content })
export const deleteItem = (projectId: string, itemId: string) => call(`/api/agent/projects/${projectId}/files/${itemId}`, 'DELETE')

/**
 * Sign → upload straight to Storage → finalize (text extraction), so the file
 * never passes through a function body. Type and size are checked here first.
 */
export async function uploadProjectFile(projectId: string, file: File): Promise<Result<{ item: ProjectItem }>> {
  if (!fileTypeOf(file.name)) return { ok: false, error: `${file.name}: ${MESSAGES.unsupported_media_type}` }
  if (file.size > MAX_FILE_BYTES) return { ok: false, error: `${file.name}: ${MESSAGES.too_large}` }
  const sign = await call<{ path: string; token: string; upload_ticket: string }>(`/api/agent/projects/${projectId}/files/sign`, 'POST', {
    filename: file.name,
    size: file.size,
  })
  if (!sign.ok) return { ok: false, error: `${file.name}: ${sign.error}` }
  try {
    const { error } = await createClient()
      .storage.from('agent-projects')
      .uploadToSignedUrl(sign.path, sign.token, file, { contentType: file.type || 'application/octet-stream' })
    if (error) return { ok: false, error: `${file.name}: ${MESSAGES.storage}` }
  } catch {
    return { ok: false, error: `${file.name}: ${MESSAGES.storage}` }
  }
  const done = await call<{ item: ProjectItem }>(`/api/agent/projects/${projectId}/files`, 'POST', {
    storage_path: sign.path,
    filename: file.name,
    upload_ticket: sign.upload_ticket,
    ...(file.type ? { mime: file.type.slice(0, 100) } : {}),
  })
  return done.ok ? done : { ok: false, error: `${file.name}: ${done.error}` }
}

/** Upload several files one after another; returns the items added and any errors. */
export async function uploadProjectFiles(projectId: string, files: File[]): Promise<{ added: ProjectItem[]; errors: string[] }> {
  const added: ProjectItem[] = []
  const errors: string[] = []
  for (const f of files) {
    const r = await uploadProjectFile(projectId, f)
    if (r.ok) added.push(r.item)
    else errors.push(r.error)
  }
  return { added, errors }
}
