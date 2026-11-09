import 'server-only'
import {
  createIssue,
  createProject,
  cycleFor,
  findProject,
  getIssues,
  getTeam,
  isLinearConfigured,
  updateIssue,
  type LinearTeam,
} from '@/lib/adapters/linear'
import { configuredBaseUrl } from '@/lib/http/origin'
import { getLinearProjectId, setLinearProjectId } from '@/lib/settings/store'
import type { LumeTaskRow } from '@/lib/db/types'
import { linearDueDate, linearStateFor, needsPush, pullPatch } from '@/lib/tasks/model'
import { applyLinearPull, getOpenLinkedTasks, setLinearResult } from '@/lib/tasks/store'

/**
 * Lume ↔ Linear for calendar tasks. One issue per task in the team's "Lume"
 * project (created on first use; its id cached in lume_settings).
 *
 *  - `pushTask` creates or updates the task's issue (title, due date in
 *    America/Los_Angeles, workflow state from the status) and records the
 *    ids or `linear_error`. It never throws: a Linear outage only leaves the
 *    task unsynced, and the next tick retries.
 *  - `pullLinear` reads the open linked tasks' issues and applies what Linear
 *    owns (date, cancel; done for a plain task) — see `pullPatch`. A task
 *    with an unpushed Lume change is skipped, so a pull never reverts an edit
 *    the push has not carried over yet.
 */

export const PROJECT_NAME = 'Lume'
export const NOT_CONFIGURED = 'not configured'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300)

async function projectId(team: LinearTeam): Promise<string> {
  const cached = await getLinearProjectId().catch(() => null)
  if (cached) return cached
  const id = (await findProject(team.id, PROJECT_NAME)) ?? (await createProject(team.id, PROJECT_NAME))
  await setLinearProjectId(id).catch((err) => console.error('[tasks] could not cache linear_project_id:', msg(err)))
  return id
}

/** Linear's issue description: the notes, then a link back to the task in Lume (when LUME_URL is set). */
export function issueDescription(task: Pick<LumeTaskRow, 'id' | 'notes' | 'action_kind'>, origin = configuredBaseUrl()): string {
  const parts: string[] = []
  if (task.notes?.trim()) parts.push(task.notes.trim())
  if (task.action_kind) parts.push(`When due, Lume files a \`${task.action_kind}\` action for approval (nothing runs without a tap).`)
  if (origin) parts.push(`[Open in Lume](${origin}/calendar?task=${task.id})`)
  return parts.join('\n\n')
}

/** Create or update the task's Linear issue. Never throws; the outcome is stored on the task. */
export async function pushTask(task: LumeTaskRow): Promise<{ ok: boolean; error?: string }> {
  if (!isLinearConfigured()) {
    if (task.linear_error !== NOT_CONFIGURED) await setLinearResult(task.id, { ok: false, error: NOT_CONFIGURED }).catch(() => null)
    return { ok: false, error: NOT_CONFIGURED }
  }
  try {
    const team = await getTeam()
    const dueDate = linearDueDate(task.due_at)
    const stateId = team.states[linearStateFor(task.status)]
    const issue = task.linear_issue_id
      ? await updateIssue(task.linear_issue_id, { title: task.title, dueDate, ...(stateId ? { stateId } : {}), description: issueDescription(task) })
      : await createIssue({
          teamId: team.id,
          projectId: await projectId(team),
          title: task.title,
          description: issueDescription(task),
          dueDate,
          ...(stateId ? { stateId } : {}),
          cycleId: cycleFor(team, dueDate),
        })
    // The version pushed is this row's updated_at: an edit landing meanwhile is newer and is pushed next time.
    await setLinearResult(task.id, { ok: true, issue_id: issue.id, identifier: issue.identifier, url: issue.url, synced_at: task.updated_at })
    return { ok: true }
  } catch (err) {
    const error = msg(err)
    console.error(`[tasks] linear push for ${task.id} failed:`, error)
    await setLinearResult(task.id, { ok: false, error }).catch(() => null)
    return { ok: false, error }
  }
}

export interface PullResult {
  checked: number
  changed: { id: string; patch: Record<string, unknown> }[]
  error?: string
}

/** Apply Linear-side changes to open linked tasks (at most `limit`). Never throws. */
export async function pullLinear(now: Date, limit = 50): Promise<PullResult> {
  if (!isLinearConfigured()) return { checked: 0, changed: [] }
  try {
    const tasks = (await getOpenLinkedTasks(limit)).filter((t) => !needsPush(t))
    if (!tasks.length) return { checked: 0, changed: [] }
    const issues = new Map((await getIssues(tasks.map((t) => t.linear_issue_id!))).map((i) => [i.id, i]))
    const changed: PullResult['changed'] = []
    const at = now.toISOString()
    for (const t of tasks) {
      const issue = issues.get(t.linear_issue_id!)
      if (!issue) continue
      const patch = pullPatch(t, issue)
      if (!patch) continue
      await applyLinearPull(t.id, patch, at)
      changed.push({ id: t.id, patch })
    }
    return { checked: tasks.length, changed }
  } catch (err) {
    const error = msg(err)
    console.error('[tasks] linear pull failed:', error)
    return { checked: 0, changed: [], error }
  }
}
