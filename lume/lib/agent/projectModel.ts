import { z } from 'zod'

/**
 * Agent projects (pure): limits, request schemas, the system prompt's
 * "Project" block and new-chat routing. A project is a folder of
 * conversations plus knowledge (instructions, files, notes) the agent sees in
 * every chat filed in it. Storage and DB live in lib/agent/projects.ts.
 */

export const MAX_FILE_BYTES = 20 * 1024 * 1024
export const MAX_PROJECT_BYTES = 200 * 1024 * 1024
/** Extracted text stored per file (the DB checks it too). */
export const MAX_TEXT_CHARS = 200_000
/** CSV: header plus this many data rows. */
export const CSV_MAX_ROWS = 200
/** The whole Project block (header, instructions, index and inline items), in characters. */
export const BLOCK_BUDGET = 20_000
/** Index lines shown before "and N more". */
export const INDEX_MAX = 100
/** read_project_file returns this many characters per call. */
export const READ_CHUNK = 20_000
export const NAME_MAX = 80
export const INSTRUCTIONS_MAX = 8000
export const NOTE_MAX = 20_000
/**
 * A pending upload older than this is an orphan the hourly sweep deletes.
 * Signed upload URLs stay valid for 2 h (storage-js createSignedUploadUrl),
 * so a younger row may still get its object. lume_project_upload_sweep()
 * uses the same 3 h.
 */
export const STALE_UPLOAD_MS = 3 * 60 * 60 * 1000

export type FileType = 'csv' | 'xlsx' | 'pdf' | 'text' | 'json' | 'image'

const EXT: Record<string, FileType> = {
  csv: 'csv',
  xlsx: 'xlsx',
  pdf: 'pdf',
  md: 'text',
  markdown: 'text',
  txt: 'text',
  json: 'json',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
}

export const ACCEPT = Object.keys(EXT).map((e) => `.${e}`).join(',')

/** The file's type from its extension, or null when it is not supported. */
export function fileTypeOf(name: string): FileType | null {
  const m = /\.([A-Za-z0-9]+)$/.exec(name.trim())
  return (m && EXT[m[1].toLowerCase()]) || null
}

export const MIME: Record<FileType, string> = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
  text: 'text/plain',
  json: 'application/json',
  image: 'application/octet-stream',
}

/** A stored content type: the browser's for images (when it is one), else from the type. */
export function mimeFor(type: FileType, name: string, browserMime?: string | null): string {
  if (type === 'image') return browserMime && /^image\/(png|jpeg|gif|webp)$/.test(browserMime) ? browserMime : 'image/png'
  if (type === 'text' && /\.(md|markdown)$/i.test(name)) return 'text/markdown'
  return MIME[type]
}

export interface Project {
  id: string
  name: string
  instructions: string
  vertical_id: string | null
  position: number
  created_at: string
  updated_at: string
}

/** A project in the list, with its knowledge totals. */
export interface ProjectSummary extends Project {
  item_count: number
  total_bytes: number
}

export interface ProjectItem {
  id: string
  kind: 'file' | 'note'
  name: string
  mime: string | null
  size_bytes: number
  readable: boolean
  truncated: boolean
  /** Length of the extracted text (0 when none). */
  text_chars?: number
  created_at: string
}

export interface ProjectItemText extends ProjectItem {
  text_content: string | null
}

const name = z.string().trim().min(1).max(NAME_MAX)
const uuid = z.string().uuid()

export const NewProject = z.object({ name, instructions: z.string().max(INSTRUCTIONS_MAX).optional(), vertical_id: uuid.nullable().optional() }).strict()
export const ProjectPatch = z
  .object({ name: name.optional(), instructions: z.string().max(INSTRUCTIONS_MAX).optional(), vertical_id: uuid.nullable().optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'nothing to change')
export const ProjectOrder = z.object({ ids: z.array(uuid).min(1).max(500) }).strict().refine((v) => new Set(v.ids).size === v.ids.length, 'duplicate ids')
export const NewNote = z.object({ name: z.string().trim().min(1).max(120).optional(), content: z.string().trim().min(1).max(NOTE_MAX) }).strict()
export const MoveConversation = z.object({ project_id: uuid.nullable() }).strict()

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

const isImage = (i: ProjectItem) => (i.mime ?? '').startsWith('image/')

/**
 * Text inside the block can never open or close one of its tags: any
 * `<project…` / `</project…` spelling (spaces, case) loses its `<`.
 */
export const neutralise = (s: string) => s.replace(/<(\s*\/?\s*project)/gi, '‹$1')
const attr = (s: string) => s.replace(/["<>\n\r]/g, ' ').slice(0, 120)
const short = (s: string) => (s.length > NAME_MAX ? `${s.slice(0, NAME_MAX - 1)}…` : s)
/** A name for running text: one line, no tag openers. */
const label = (s: string) => neutralise(short(s.replace(/[\n\r]+/g, ' ')))

/** Newest first; ties broken by id so the block (and its cache) is stable. */
export function newestFirst<T extends { created_at: string; id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
}

/** Per-item markup around inline text (tag, attributes, newlines), for budgeting from metadata. */
const WRAP_OVERHEAD = 200

/**
 * From metadata alone (`text_chars`): the ids whose text is worth fetching
 * for the block, newest first, greedily within BLOCK_BUDGET. A superset of
 * what `projectBlock` will inline (it also spends budget on the header and
 * the index), so only these items' text is ever loaded.
 */
export function pickInlineIds(items: ProjectItem[], budget = BLOCK_BUDGET): string[] {
  let left = budget
  const ids: string[] = []
  for (const i of newestFirst(items).slice(0, INDEX_MAX)) {
    const n = i.text_chars ?? 0
    if (!i.readable || n <= 0) continue
    if (n + WRAP_OVERHEAD <= left) {
      ids.push(i.id)
      left -= n + WRAP_OVERHEAD
    }
  }
  return ids
}

const sizeLabel = (i: ProjectItemText) => formatBytes(i.size_bytes)

const wrap = (i: ProjectItemText) => `<project_item id="${i.id}" name="${attr(i.name)}">\n${neutralise(i.text_content ?? '')}\n</project_item>`

/**
 * The cached system-prompt block for a chat filed in `project`: its name,
 * instructions, an index of `items` (newest first), and the full text of as
 * many small items as fit in BLOCK_BUDGET, newest first; an item too big for
 * what is left is skipped (a smaller, older one may still fit). Everything
 * else is read with read_project_file. Only `items` are ever included: the
 * caller passes this project's items alone.
 */
export function projectBlock(project: Pick<Project, 'id' | 'name' | 'instructions'>, items: ProjectItemText[]): string {
  const sorted = newestFirst(items)
  const instructions = project.instructions.trim()
  const head = [
    `<project name="${attr(project.name)}">`,
    `Project: ${label(project.name)}`,
    `This chat is filed in Conrad's project "${label(project.name)}". Follow its instructions and use its files and notes in this chat. ` +
      'Items not shown in full below can be read with read_project_file(id, offset).',
    '',
    'Instructions:',
    instructions ? neutralise(instructions) : '(No instructions.)',
    '',
    sorted.length ? 'Files and notes (newest first):' : 'Files and notes: none yet.',
  ].join('\n')
  const tail = '</project>'

  const textOf = (i: ProjectItemText) => (i.readable && i.text_content ? i.text_content : null)

  // Index lines, measured with the longer status so the inline budget is safe.
  const LONG = ' · not inline, use read_project_file'
  const base = (i: ProjectItemText) => {
    const flags = [i.truncated ? 'truncated' : null].filter(Boolean)
    return `- [${i.kind}] ${label(i.name)} · ${sizeLabel(i)}${flags.length ? ` · ${flags.join(', ')}` : ''} · id ${i.id}`
  }
  let shown = sorted.slice(0, INDEX_MAX)
  const more = () => (sorted.length > shown.length ? `\n- …and ${sorted.length - shown.length} more (ask Conrad, or list the project)` : '')
  const indexLen = () => shown.reduce((s, i) => s + base(i).length + LONG.length + 1, 0) + more().length
  // Leave at least a little room for content; an oversized index is cut.
  while (shown.length > 1 && head.length + indexLen() + tail.length > BLOCK_BUDGET - 1000) shown = shown.slice(0, -1)

  let left = BLOCK_BUDGET - head.length - indexLen() - tail.length - 4
  const inline = new Set<string>()
  for (const i of shown) {
    const t = textOf(i)
    if (t === null) continue
    const len = wrap(i).length + 2
    if (len <= left) {
      inline.add(i.id)
      left -= len
    }
  }

  const status = (i: ProjectItemText) => {
    if (inline.has(i.id)) return ' · inline below'
    if (i.kind === 'file' && isImage(i)) return ' · image, listed by name only'
    if (!i.readable) return ' · not readable'
    return LONG
  }
  const index = shown.map((i) => base(i) + status(i)).join('\n') + more()
  const bodies = shown.filter((i) => inline.has(i.id)).map(wrap)
  return [head, index, ...(bodies.length ? ['', ...bodies] : []), tail].filter((s) => s !== '').join('\n')
}

/** One window of an item's text for read_project_file. */
export function readChunk(text: string, offset: number, size = READ_CHUNK): { text: string; offset: number; next_offset: number | null; total_chars: number } {
  const start = Math.max(0, Math.min(Math.floor(offset), text.length))
  const end = Math.min(text.length, start + size)
  return { text: text.slice(start, end), offset: start, next_offset: end < text.length ? end : null, total_chars: text.length }
}

/**
 * Which project a NEW conversation is filed in: an explicit `project_id`
 * (from "New chat in project") wins and must exist; otherwise a chat tagged
 * with a vertical (its Grok Bot's, or the owner's from /operator) goes to the
 * vertical's linked live project, if any; otherwise Unfiled.
 */
export async function resolveNewChatProject(
  input: { requestedProjectId: string | null; verticalId: string | null },
  deps: { getProject: (id: string) => Promise<{ id: string } | null>; projectForVertical: (verticalId: string) => Promise<{ id: string } | null> }
): Promise<{ ok: true; projectId: string | null } | { ok: false }> {
  if (input.requestedProjectId) {
    const p = await deps.getProject(input.requestedProjectId)
    return p ? { ok: true, projectId: p.id } : { ok: false }
  }
  if (!input.verticalId) return { ok: true, projectId: null }
  const linked = await deps.projectForVertical(input.verticalId)
  return { ok: true, projectId: linked?.id ?? null }
}

/**
 * Who may use a project. `scope` is null for full access (the owner, the
 * master Grok Bot, the agent's internal bearer); a vertical Grok Bot's scope
 * is its vertical: it may use its own vertical's project and unlinked ones,
 * never another vertical's.
 */
export type ProjectScope = { verticalId: string | null } | null

export const canUseProject = (scope: ProjectScope, project: Pick<Project, 'vertical_id'>) =>
  !scope || project.vertical_id === null || project.vertical_id === scope.verticalId

/** Linking (create / PATCH vertical_id): a vertical bot may link only to its own vertical, or unlink. */
export const canLinkVertical = (scope: ProjectScope, verticalId: string | null | undefined) =>
  !scope || verticalId === undefined || verticalId === null || verticalId === scope.verticalId
