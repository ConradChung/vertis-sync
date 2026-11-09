import 'server-only'
import type { LinearIssueState, LinearStateType } from '@/lib/tasks/model'

/**
 * Linear GraphQL (https://api.linear.app/graphql), for the Calendar's task
 * mirror (lib/tasks/sync.ts). Server-only: `LINEAR_API_KEY` (a personal API
 * key, sent as the bare `Authorization` header) never reaches the browser,
 * logs or errors. `LINEAR_TEAM_KEY` picks the team (default `GTM`).
 *
 * Unset key: `isLinearConfigured()` is false and the sync records
 * `linear_error = 'not configured'` without calling anything.
 *
 * Every call has an 8 s timeout. GraphQL `errors` and non-2xx answers throw
 * `LinearError` with a short message (no request body echoed).
 */

export const LINEAR_URL = 'https://api.linear.app/graphql'
const TIMEOUT_MS = 8_000
const TEAM_TTL_MS = 10 * 60_000

export class LinearError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'LinearError'
    this.status = status
  }
}

export const isLinearConfigured = (): boolean => Boolean(process.env.LINEAR_API_KEY?.trim())
export const linearTeamKey = (): string => process.env.LINEAR_TEAM_KEY?.trim() || 'GTM'

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const key = process.env.LINEAR_API_KEY?.trim()
  if (!key) throw new LinearError(0, 'not configured')
  let res: Response
  try {
    res = await fetch(LINEAR_URL, {
      method: 'POST',
      headers: { Authorization: key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables }),
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    throw new LinearError(0, timedOut ? 'Linear timed out' : 'Linear unreachable')
  }
  const body = (await res.json().catch(() => null)) as { data?: T; errors?: { message?: string }[] } | null
  if (!res.ok || !body || body.errors?.length || !body.data) {
    const first = body?.errors?.[0]?.message ?? `HTTP ${res.status}`
    throw new LinearError(res.status, `Linear: ${String(first).slice(0, 200)}`)
  }
  return body.data
}

// ---------------------------------------------------------------------------
// Team

export interface LinearCycle {
  id: string
  startsAt: string
  endsAt: string
}

export interface LinearTeam {
  id: string
  key: string
  cyclesEnabled: boolean
  activeCycle: LinearCycle | null
  /** Upcoming cycles (active + future), for a due date past the active one. */
  cycles: LinearCycle[]
  /** First state (lowest position) of each type. */
  states: Partial<Record<LinearStateType, string>>
}

let teamCache: { key: string; team: LinearTeam; expires: number } | null = null

/** Test hook. */
export function clearLinearCache(): void {
  teamCache = null
}

const TEAM_QUERY = `query LumeTeam($key: String!) {
  teams(filter: { key: { eq: $key } }, first: 1) {
    nodes {
      id key cyclesEnabled
      activeCycle { id startsAt endsAt }
      states(first: 50) { nodes { id type position } }
    }
  }
}`

const CYCLES_QUERY = `query LumeCycles($teamId: String!) {
  team(id: $teamId) { cycles(first: 25, filter: { isPast: { eq: false } }) { nodes { id startsAt endsAt } } }
}`

export async function getTeam(key = linearTeamKey()): Promise<LinearTeam> {
  if (teamCache && teamCache.key === key && teamCache.expires > Date.now()) return teamCache.team
  type Raw = {
    teams: {
      nodes: { id: string; key: string; cyclesEnabled: boolean; activeCycle: LinearCycle | null; states: { nodes: { id: string; type: string; position: number }[] } }[]
    }
  }
  const data = await gql<Raw>(TEAM_QUERY, { key })
  const raw = data.teams.nodes[0]
  if (!raw) throw new LinearError(404, `Linear: no team with key ${key}`)
  const states: LinearTeam['states'] = {}
  for (const s of [...raw.states.nodes].sort((a, b) => a.position - b.position)) {
    const t = s.type as LinearStateType
    if ((t === 'unstarted' || t === 'started' || t === 'completed' || t === 'canceled') && !states[t]) states[t] = s.id
  }
  let cycles: LinearCycle[] = []
  if (raw.cyclesEnabled) {
    // Best effort: an issue without a cycle is still an issue.
    cycles = await gql<{ team: { cycles: { nodes: LinearCycle[] } } }>(CYCLES_QUERY, { teamId: raw.id })
      .then((d) => d.team.cycles.nodes)
      .catch(() => [])
  }
  const team: LinearTeam = { id: raw.id, key: raw.key, cyclesEnabled: raw.cyclesEnabled, activeCycle: raw.activeCycle, cycles, states }
  teamCache = { key, team, expires: Date.now() + TEAM_TTL_MS }
  return team
}

/**
 * The cycle an issue due on `date` (YYYY-MM-DD) belongs in: none when the team
 * has cycles off; the active cycle when the date falls inside it; else the
 * upcoming cycle containing the date; else none.
 */
export function cycleFor(team: Pick<LinearTeam, 'cyclesEnabled' | 'activeCycle' | 'cycles'>, date: string): string | null {
  if (!team.cyclesEnabled) return null
  const inside = (c: LinearCycle) => date >= c.startsAt.slice(0, 10) && date < c.endsAt.slice(0, 10)
  if (team.activeCycle && inside(team.activeCycle)) return team.activeCycle.id
  return team.cycles.find(inside)?.id ?? null
}

// ---------------------------------------------------------------------------
// Project

export async function findProject(teamId: string, name: string): Promise<string | null> {
  const data = await gql<{ team: { projects: { nodes: { id: string; name: string }[] } } }>(
    `query LumeProject($teamId: String!, $name: String!) {
      team(id: $teamId) { projects(first: 5, filter: { name: { eq: $name } }) { nodes { id name } } }
    }`,
    { teamId, name }
  )
  return data.team.projects.nodes[0]?.id ?? null
}

export async function createProject(teamId: string, name: string): Promise<string> {
  const data = await gql<{ projectCreate: { success: boolean; project: { id: string } | null } }>(
    `mutation LumeProjectCreate($input: ProjectCreateInput!) { projectCreate(input: $input) { success project { id } } }`,
    { input: { name, teamIds: [teamId], description: 'Scheduled tasks from Lume (Calendar). Edits to dates and cancels sync back.' } }
  )
  if (!data.projectCreate.success || !data.projectCreate.project) throw new LinearError(500, 'Linear: projectCreate failed')
  return data.projectCreate.project.id
}

// ---------------------------------------------------------------------------
// Issues

export interface LinearIssueRef {
  id: string
  identifier: string
  url: string
}

export interface IssueCreateInput {
  teamId: string
  projectId: string
  title: string
  description: string
  dueDate: string
  stateId?: string
  cycleId?: string | null
}

export async function createIssue(input: IssueCreateInput): Promise<LinearIssueRef> {
  const data = await gql<{ issueCreate: { success: boolean; issue: LinearIssueRef | null } }>(
    `mutation LumeIssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }`,
    {
      input: {
        teamId: input.teamId,
        projectId: input.projectId,
        title: input.title,
        description: input.description,
        dueDate: input.dueDate,
        ...(input.stateId ? { stateId: input.stateId } : {}),
        ...(input.cycleId ? { cycleId: input.cycleId } : {}),
      },
    }
  )
  if (!data.issueCreate.success || !data.issueCreate.issue) throw new LinearError(500, 'Linear: issueCreate failed')
  return data.issueCreate.issue
}

export interface IssueUpdateInput {
  title?: string
  dueDate?: string
  stateId?: string
  description?: string
}

export async function updateIssue(id: string, input: IssueUpdateInput): Promise<LinearIssueRef> {
  const data = await gql<{ issueUpdate: { success: boolean; issue: LinearIssueRef | null } }>(
    `mutation LumeIssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id identifier url } } }`,
    { id, input }
  )
  if (!data.issueUpdate.success || !data.issueUpdate.issue) throw new LinearError(500, 'Linear: issueUpdate failed')
  return data.issueUpdate.issue
}

/** The linked issues' current state (missing / deleted ids are simply absent). At most 50 ids. */
export async function getIssues(ids: string[]): Promise<LinearIssueState[]> {
  if (ids.length === 0) return []
  const data = await gql<{ issues: { nodes: { id: string; title: string; dueDate: string | null; updatedAt: string; state: { type: string } | null }[] } }>(
    `query LumeIssues($ids: [ID!]!) {
      issues(first: 50, filter: { id: { in: $ids } }) { nodes { id title dueDate updatedAt state { type } } }
    }`,
    { ids: ids.slice(0, 50) }
  )
  return data.issues.nodes.map((n) => ({ id: n.id, title: n.title, dueDate: n.dueDate, updatedAt: n.updatedAt, stateType: n.state?.type ?? '' }))
}
