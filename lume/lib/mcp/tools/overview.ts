import { z } from 'zod'
import { getBankThreshold } from '@/lib/settings/store'
import { BANK_STATES, countOf, must, sb } from '../db'
import { untrusted } from '../sanitize'
import { defineTool, READ_ONLY } from '../tool'

const SEVERITY_RANK: Record<string, number> = { urgent: 0, warn: 1, info: 2 }
/** Unacked alerts read for counting; the backlog is ~130 today. */
const ALERT_SCAN_CAP = 2000

type AlertRow = { id: string; severity: string; source: string; title: string | null; created_at: string }

/** Counts by severity and source, plus the top `n` by urgency (urgent → warn → info), newest first within each. */
export function summarizeAlerts(rows: AlertRow[], total: number, n: number) {
  const by_severity: Record<string, number> = {}
  const by_source: Record<string, number> = {}
  for (const r of rows) {
    by_severity[r.severity] = (by_severity[r.severity] ?? 0) + 1
    by_source[r.source] = (by_source[r.source] ?? 0) + 1
  }
  const rank = (s: string) => SEVERITY_RANK[s] ?? 3
  const top = [...rows]
    .sort((a, b) => rank(a.severity) - rank(b.severity) || b.created_at.localeCompare(a.created_at))
    .slice(0, n)
    .map((r) => ({ id: r.id, severity: r.severity, source: r.source, created_at: r.created_at, title: untrusted(r.title, 160) }))
  const oldest = rows.reduce<string | null>((m, r) => (m === null || r.created_at < m ? r.created_at : m), null)
  const topSources = Object.fromEntries(Object.entries(by_source).sort((a, b) => b[1] - a[1]).slice(0, 10))
  return {
    unacked: total,
    by_severity,
    by_source_top10: topSources,
    oldest_unacked_at: oldest,
    counted_rows: rows.length,
    top,
  }
}

/**
 * Duet's polling entry point: one compact response, counts plus a short
 * top-N of alerts. Anything non-zero here is worth a follow-up call.
 */
export const getOverview = defineTool({
  name: 'lume_get_overview',
  title: 'Lume overview',
  description:
    'Start here. One compact snapshot of what needs attention: unacked alert counts (by severity and source) with the top `top_alerts` by urgency then recency, lead bank counts by state, actions awaiting approval, and failed runs in the last `since_hours` (default 24). No lead data. Read-only, no side effects. Cheap to poll every few hours; use lume_list_alerts for the full alert list.',
  cls: 'read',
  input: z.object({
    since_hours: z.number().int().min(1).max(168).optional().describe('Window for failed runs (default 24, max 168).'),
    top_alerts: z.number().int().min(0).max(20).optional().describe('How many unacked alerts to include, most urgent and newest first (default 5, max 20).'),
  }),
  annotations: READ_ONLY,
  run: async ({ since_hours, top_alerts }) => {
    const now = new Date()
    const since = new Date(now.getTime() - (since_hours ?? 24) * 3_600_000).toISOString()
    const db = sb()
    const head = { count: 'exact' as const, head: true }

    const [
      alerts,
      bankCounts,
      threshold,
      awaiting,
      failedActions,
      failedValidation,
      failedInfluencer,
      failedAgent,
      activeValidation,
      lastRotation,
    ] = await Promise.all([
      db
        .from('lume_alerts')
        .select('id,severity,source,title,created_at', { count: 'exact' })
        .is('acked_at', null)
        .order('created_at', { ascending: false })
        .limit(ALERT_SCAN_CAP),
      Promise.all(BANK_STATES.map(async (s) => [s, countOf(`lead_bank ${s}`, await db.from('lead_bank').select('id', head).eq('state', s))] as const)),
      getBankThreshold(),
      db.from('pending_actions').select('id,kind,created_at').eq('status', 'awaiting').order('created_at', { ascending: true }).limit(200),
      db.from('pending_actions').select('id', head).eq('status', 'failed').gte('updated_at', since),
      db.from('validation_jobs').select('id', head).eq('status', 'failed').gte('updated_at', since),
      db.from('influencer_runs').select('id', head).eq('status', 'failed').gte('updated_at', since),
      db.from('agent_runs').select('id', head).eq('status', 'failed').gte('created_at', since),
      db.from('validation_jobs').select('id', head).in('status', ['pending', 'processing']),
      db.from('rotation_runs').select('id,ran_at,errors').order('ran_at', { ascending: false }).limit(1),
    ])

    const alertRows = must('alerts', alerts) as AlertRow[]
    const awaitingRows = must('awaiting', awaiting) as { kind: string; created_at: string }[]
    const byKind: Record<string, number> = {}
    for (const r of awaitingRows) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1
    const by_state = Object.fromEntries(bankCounts)
    const rot = (must('rotation', lastRotation) as { ran_at: string; errors: unknown }[])[0]
    const rotErrors = Array.isArray(rot?.errors) ? rot.errors.length : rot?.errors && typeof rot.errors === 'object' ? Object.keys(rot.errors).length : 0

    return {
      data: {
        as_of: now.toISOString(),
        alerts: summarizeAlerts(alertRows, alerts.count ?? alertRows.length, top_alerts ?? 5),
        lead_bank: {
          total: bankCounts.reduce((n, [, c]) => n + c, 0),
          by_state,
          // Not a floor: a push with more eligible leads than this is held in the
          // bank as `queued` and rotated in over time (Settings → Budget).
          push_bank_threshold: threshold,
          queued_waiting_for_rotation: by_state.queued ?? 0,
        },
        pending_actions: {
          awaiting: awaitingRows.length,
          awaiting_by_kind: byKind,
          oldest_awaiting_at: awaitingRows[0]?.created_at ?? null,
        },
        failed_since: {
          since,
          actions: countOf('failed actions', failedActions),
          validation_jobs: countOf('failed validation', failedValidation),
          influencer_runs: countOf('failed influencer', failedInfluencer),
          agent_runs: countOf('failed agent', failedAgent),
        },
        validation: { active_jobs: countOf('active validation', activeValidation) },
        rotation: { last_run_at: rot?.ran_at ?? null, last_run_errors: rotErrors },
      },
    }
  },
})
