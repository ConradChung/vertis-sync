import { after, NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { ActionRequestBody } from '@/lib/actions/build'
import { isLinearConfigured } from '@/lib/adapters/linear'
import type { Json } from '@/lib/db/types'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody } from '@/lib/http/json'
import { ownerDayStart } from '@/lib/time/owner'
import { parseDue, TaskCreateBody } from '@/lib/tasks/model'
import { insertTask, lastLinearError, listTasks } from '@/lib/tasks/store'
import { pushTask } from '@/lib/tasks/sync'

/**
 * Calendar tasks.
 *  GET  ?from&to  → tasks due in [from, to) (YYYY-MM-DD owner-zone dates or
 *                   ISO instants; at most 120 days), plus Linear's state for
 *                   the banner: `{ tasks, linear: { configured, error } }`.
 *  POST           → schedule a task `{ title, notes?, due, action? }`. `due`
 *                   is YYYY-MM-DD (all day, 09:00 Pacific) or an ISO
 *                   datetime. `action` is a request as POST /api/actions
 *                   takes it (shape-checked now, built fresh when due).
 *
 * Scheduling spends nothing and needs no tap: when the task falls due the
 * rotation tick files its action as an awaiting pending action, which the
 * owner still approves. So both the owner's session and the agent's internal
 * bearer may write here (the agent's tasks are recorded `created_by: agent`).
 * The Linear push runs after the response.
 */

const MAX_RANGE_MS = 120 * 24 * 3600_000

function bound(raw: string | null): Date | null {
  if (!raw) return null
  const d = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? ownerDayStart(raw) : new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d
}

export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const url = new URL(req.url)
  const from = bound(url.searchParams.get('from'))
  const to = bound(url.searchParams.get('to'))
  if (!from || !to || to <= from || to.getTime() - from.getTime() > MAX_RANGE_MS) {
    return NextResponse.json({ error: 'invalid_range' }, { status: 400 })
  }
  try {
    const configured = isLinearConfigured()
    const [tasks, lastError] = await Promise.all([listTasks(from.toISOString(), to.toISOString()), configured ? lastLinearError() : null])
    return NextResponse.json({ tasks, linear: { configured, error: lastError } })
  } catch (err) {
    return dbErrorResponse(err, 'api/tasks')
  }
}

export async function POST(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const body = await parseJsonBody(req, TaskCreateBody, 256 * 1024)
  if (!body.ok) return body.response
  const { title, notes, due, action, conversation_id } = body.data
  const when = parseDue(due)
  if (!when) return NextResponse.json({ error: 'invalid_due' }, { status: 400 })
  if (action && !ActionRequestBody.safeParse(action).success) {
    return NextResponse.json({ error: 'invalid_action' }, { status: 400 })
  }
  try {
    const task = await insertTask({
      title,
      notes: notes?.trim() || null,
      due_at: when.due_at,
      all_day: when.all_day,
      action_kind: action?.kind ?? null,
      action_payload: action ? (action.payload as Record<string, Json>) : null,
      created_by: auth.via === 'internal' ? 'agent' : 'owner',
      conversation_id: auth.via === 'internal' ? (conversation_id ?? null) : null,
    })
    after(() => pushTask(task).then(() => undefined))
    return NextResponse.json({ ok: true, task }, { status: 201 })
  } catch (err) {
    return dbErrorResponse(err, 'api/tasks')
  }
}
