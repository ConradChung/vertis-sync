/**
 * Browser-side calls for the Calendar. Never throw: a network failure is
 * `{ status: 0 }`. Scheduling runs nothing — a task's action is filed for a
 * tap only when it falls due.
 */
import { sendJson, type ApiAnswer } from '@/lib/validate/client'
import type { LumeTaskRow, TaskStatus } from '@/lib/db/types'

export interface TasksPayload {
  tasks: LumeTaskRow[]
  linear: { configured: boolean; error: { error: string; at: string } | null }
}

type TaskAnswer = { ok: true; task: LumeTaskRow; note?: string }

export const createTask = (body: { title: string; notes?: string; due: string }) => sendJson<TaskAnswer>('/api/tasks', body)

export const patchTask = (id: string, body: { title?: string; notes?: string | null; due?: string; status?: 'scheduled' | 'done' | 'cancelled' }) =>
  sendJson<TaskAnswer>(`/api/tasks/${id}`, body, { method: 'PATCH' })

export const cancelTask = (id: string) => sendJson<TaskAnswer>(`/api/tasks/${id}`, undefined, { method: 'DELETE' })

const ERRORS: Record<string, string> = {
  invalid_due: 'That date or time is not valid.',
  invalid_body: 'Check the title and date.',
  invalid_transition: 'That change is not allowed from the current status.',
  action_filed: 'Its action is already filed for approval; decide that first.',
  conflict: 'The task changed meanwhile — refresh and try again.',
  not_found: 'Task not found.',
}

export function taskErrorText(a: ApiAnswer<unknown>): string {
  if (a.status === 0) return a.aborted ? 'Timed out — refresh to check.' : 'Network error — nothing was saved.'
  const code = (a.body as { error?: string } | null)?.error
  return (code && ERRORS[code]) || `Request failed (${a.status}).`
}

/** The `due` a form sends: a date alone is all day; with a time, owner-zone wall time. */
export const dueOf = (date: string, time: string) => (time ? `${date}T${time}` : date)

export const STATUS_LABEL: Record<TaskStatus, string> = {
  scheduled: 'Scheduled',
  awaiting_tap: 'Awaiting your tap',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

/** Chip / badge colours per status (palette tokens). */
export const STATUS_TONE: Record<TaskStatus, string> = {
  scheduled: 'border-lime/30 bg-lime/12 text-positive',
  awaiting_tap: 'border-amber/40 bg-amber/15 text-amber',
  running: 'border-cyan/30 bg-cyan/10 text-cyan',
  done: 'border-line bg-white/5 text-fg-70',
  failed: 'border-red/40 bg-red/12 text-red',
  cancelled: 'border-line bg-transparent text-fg-46 line-through',
}
