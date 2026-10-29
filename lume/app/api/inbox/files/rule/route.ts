import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { appendProjectLine, NotANoteError, ProjectGoneError } from '@/lib/agent/projects'
import { inboxProject } from '@/lib/inbox/project'
import { RuleBody } from '@/lib/inbox/schemas'
import { inboxScope } from '@/lib/inbox/scope'
import { inboxFailure, NO_STORE, readInboxJson } from '@/lib/inbox/http'

/**
 * POST /api/inbox/files/rule `{ file, rule, vertical_id? }` — the SOP's
 * "every correction becomes a rule": append ONE line to a named file in the
 * vertical's linked project (e.g. voice-rules.md, qualify-rules.md,
 * reply-templates.md), creating it as a note when missing. Newlines in the
 * rule are folded to spaces; an uploaded (non-note) file of that name is
 * never rewritten (409 not_a_note). 200 `{ file: { id, name, created, chars } }`.
 * docs/lume/INBOX-MANAGER-API.md.
 */
const Body = RuleBody.extend({ vertical_id: z.uuid().optional() })

export async function POST(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const body = await readInboxJson(req, Body, 8 * 1024)
  if (!body.ok) return body.response
  try {
    const project = await inboxProject(await inboxScope(req, auth), body.data.vertical_id?.toLowerCase() ?? null)
    const file = await appendProjectLine(project.id, body.data.file, body.data.rule)
    return NextResponse.json({ ok: true, project, file }, { headers: NO_STORE })
  } catch (err) {
    if (err instanceof NotANoteError) return NextResponse.json({ error: 'not_a_note' }, { status: 409 })
    if (err instanceof ProjectGoneError) return NextResponse.json({ error: 'project_not_found' }, { status: 404 })
    return inboxFailure(err, 'api/inbox/files/rule')
  }
}
