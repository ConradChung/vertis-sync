import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { getItemText, listItems } from '@/lib/agent/projects'
import { readChunk } from '@/lib/agent/projectModel'
import { inboxProject } from '@/lib/inbox/project'
import { inboxScope } from '@/lib/inbox/scope'
import { inboxFailure, NO_STORE } from '@/lib/inbox/http'

/**
 * GET /api/inbox/files[?vertical_id=][&name=voice-rules.md][&offset=]
 *
 * The inbox bot's memory files in its vertical's linked project. Without
 * `name`: the list (id, name, kind, size, created_at). With `name`: the
 * newest item of that name (case-insensitive) with its text, in 20,000-char
 * chunks (`next_offset`). A vertical bot always reads its own vertical's
 * project; the owner / master / agent pass `vertical_id`.
 * docs/lume/INBOX-MANAGER-API.md.
 */
const Query = z.object({
  vertical_id: z.uuid().optional(),
  name: z.string().trim().min(1).max(120).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const q = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams))
  if (!q.success) return NextResponse.json({ error: 'invalid_query' }, { status: 400 })
  try {
    const project = await inboxProject(await inboxScope(req, auth), q.data.vertical_id?.toLowerCase() ?? null)
    const items = await listItems(project.id)
    if (!q.data.name) {
      const files = items.map(({ id, name, kind, size_bytes, readable, created_at }) => ({ id, name, kind, size_bytes, readable, created_at }))
      return NextResponse.json({ project, files }, { headers: NO_STORE })
    }
    const want = q.data.name.toLowerCase()
    const hit = items.find((i) => i.name.trim().toLowerCase() === want)
    if (!hit) return NextResponse.json({ error: 'file_not_found', project }, { status: 404 })
    const item = await getItemText(project.id, hit.id)
    if (!item) return NextResponse.json({ error: 'file_not_found', project }, { status: 404 })
    return NextResponse.json(
      { project, file: { id: item.id, name: item.name, kind: item.kind, readable: item.readable, ...readChunk(item.text_content ?? '', q.data.offset ?? 0) } },
      { headers: NO_STORE }
    )
  } catch (err) {
    return inboxFailure(err, 'api/inbox/files')
  }
}
