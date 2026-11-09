/**
 * The Validate page's "Running" section (pure): which validation jobs to show
 * and how often to poll. Jobs come from `GET /api/jobs`.
 */

export interface JobSummary {
  id: string
  filename: string | null
  status: string | null
  total_rows: number
  processed_rows: number
  /** The job's own counters (the list's invalid rate: invalid ÷ (valid + invalid)). */
  valid_count?: number
  invalid_count?: number
  enrich: boolean
  /** For the Progress queue's stage and bar. */
  enrich_started?: boolean
  enriched_rows?: number
  instantly_status?: string | null
  eta_seconds?: number | null
  eta_updated_at?: string | null
  created_at: string
  updated_at: string
  error_message: string | null
  /** The job's tag (lib/tags). */
  vertical_id?: string | null
}

export const RUNNING_STATUSES: ReadonlySet<string> = new Set(['pending', 'processing'])
/** Finished jobs stay listed this long (by updated_at). */
export const RECENT_MS = 24 * 60 * 60 * 1000

const isRunning = (j: Pick<JobSummary, 'status'>) => RUNNING_STATUSES.has(j.status ?? '')

/** Running jobs (any age, as listed) and jobs finished within RECENT_MS, newest update first. */
export function partitionJobs(jobs: readonly JobSummary[], now = Date.now()): { running: JobSummary[]; recent: JobSummary[] } {
  const running = jobs.filter(isRunning)
  const recent = jobs
    .filter((j) => !isRunning(j) && now - Date.parse(j.updated_at) <= RECENT_MS)
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
  return { running, recent }
}

/** Same cadence as useJobProgress: 5 s while anything runs, else 60 s. */
export const jobsPollInterval = (data: { jobs: JobSummary[] } | undefined) => (data?.jobs.some(isRunning) ? 5_000 : 60_000)

/** The reason to show under a finished job: always for failed / cancelled, else only when one was recorded. */
export function showsError(j: Pick<JobSummary, 'status' | 'error_message'>): string | null {
  const msg = j.error_message?.trim() || null
  if (j.status === 'failed' || j.status === 'cancelled') return msg ?? 'No reason recorded.'
  return msg
}

/** "5,272 leads · 06 Nov": the owner reads a job by its size and day, not its filename. */
export function jobTitle(j: Pick<JobSummary, 'total_rows' | 'created_at'>): string {
  const day = new Date(j.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
  return `${j.total_rows.toLocaleString('en-US')} leads · ${day}`
}
