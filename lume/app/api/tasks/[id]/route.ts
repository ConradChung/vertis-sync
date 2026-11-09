import { after, NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody, uuidParam } from '@/lib/http/json'
import { manualTransitionOk, parseDue, TaskPatchBody } from '@/lib/tasks/model'
import { getTask, updateTask, type TaskUpdate } from '@/lib/tasks/store'
import { pushTask } from '@/lib/tasks/sync'

/**
 * One calendar task.
 *  GET    → the task (the Calendar's `?task=<id>` deep link).
 *  PATCH  → `{ title?, notes?, due?, status? }`; status only to scheduled
 *           (reschedule: from scheduled / failed / cancelled, which re-arms
 *           the task — its action is filed again when due), done, or
 *           cancelled. The due date of a task whose action is already filed
 *           (awaiting_tap / running) cannot move: 409 `action_filed`.
 *  DELETE → cancel. A filed action is not touched: it still awaits its own
 *           decision (the response says so).
 * Linear is pushed after the response.
 */

type Ctx = { params: Promise<{ id: string }> }

export async function GET(req: Request, { params }: Ctx) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await params).id)
  if (!id) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  try {
    const task = await getTask(id)
    return task ? NextResponse.json({ task }) : NextResponse.json({ error: 'not_found' }, { status: 404 })
  } catch (err) {
    return dbErrorResponse(err, 'api/tasks/[id]')
  }
}

export async function PATCH(req: Request, { params }: Ctx) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await params).id)
  if (!id) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const body = await parseJsonBody(req, TaskPatchBody, 16 * 1024)
  if (!body.ok) return body.response
  const input = body.data
  try {
    const task = await getTask(id)
    if (!task) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    if (input.status && input.status !== task.status && !manualTransitionOk(task.status, input.status)) {
      return NextResponse.json({ error: 'invalid_transition', from: task.status, to: input.status }, { status: 409 })
    }
    const patch: TaskUpdate = {}
    if (input.title !== undefined) patch.title = input.title
    if (input.notes !== undefined) patch.notes = input.notes?.trim() || null
    if (input.due !== undefined) {
      const when = parseDue(input.due)
      if (!when) return NextResponse.json({ error: 'invalid_due' }, { status: 400 })
      if ((task.status === 'awaiting_tap' || task.status === 'running') && input.status !== 'cancelled' && input.status !== 'done') {
        return NextResponse.json({ error: 'action_filed', action_id: task.action_id }, { status: 409 })
      }
      patch.due_at = when.due_at
      patch.all_day = when.all_day
      patch.reminded_at = null
    }
    if (input.status) patch.status = input.status
    if (input.status === 'scheduled' && task.status !== 'scheduled') {
      // Re-armed: the next due run files a fresh action / reminder.
      Object.assign(patch, { action_id: null, last_error: null, reminded_at: null })
    }
    const updated = await updateTask(id, patch, [task.status])
    if (!updated) return NextResponse.json({ error: 'conflict' }, { status: 409 })
    after(() => pushTask(updated).then(() => undefined))
    const note =
      input.status === 'cancelled' && task.status === 'awaiting_tap' && task.action_id
        ? 'The filed action still awaits its own decision; deny it on /actions to drop it.'
        : undefined
    return NextResponse.json({ ok: true, task: updated, ...(note ? { note } : {}) })
  } catch (err) {
    return dbErrorResponse(err, 'api/tasks/[id]')
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await params).id)
  if (!id) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  try {
    const task = await getTask(id)
    if (!task) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    if (task.status === 'cancelled') return NextResponse.json({ ok: true, task })
    if (task.status === 'done') return NextResponse.json({ error: 'invalid_transition', from: 'done', to: 'cancelled' }, { status: 409 })
    const updated = await updateTask(id, { status: 'cancelled' }, [task.status])
    if (!updated) return NextResponse.json({ error: 'conflict' }, { status: 409 })
    after(() => pushTask(updated).then(() => undefined))
    const note = task.status === 'awaiting_tap' && task.action_id ? 'The filed action still awaits its own decision; deny it on /actions to drop it.' : undefined
    return NextResponse.json({ ok: true, task: updated, ...(note ? { note } : {}) })
  } catch (err) {
    return dbErrorResponse(err, 'api/tasks/[id]')
  }
}
