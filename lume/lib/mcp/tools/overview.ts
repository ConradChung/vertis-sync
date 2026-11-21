import { z } from 'zod'
import { getBankThreshold } from '@/lib/settings/store'
import { countOf, must, sb } from '../db'
import { defineTool, READ_ONLY } from '../tool'

/**
 * Duet's polling entry point: one compact response, counts only, ~10 head
 * queries in parallel. Anything non-zero here is worth a follow-up call.
 */
export const getOverview = defineTool({
  name: 'lume_get_overview',
  title: 'Lume overview',
  description:
    'Start here. One compact snapshot of what needs attention: unacked alerts, lead bank vs threshold, actions awaiting approval, and failed runs in the last `since_hours` (default 24). Counts only, no lead data. Read-only, no side effects. Cheap to poll every few hours.',
  cls: 'read',
  input: z.object({
    since_hours: z.number().int().min(1).max(168).optional().describe('Window for failed runs (default 24, max 168).'),
  }),
  annotations: READ_ONLY,
  run: async ({ since_hours }) => {
    const now = new Date()
    const since = new Date(now.getTime() - (since_hours ?? 24) * 3_600_000).toISOString()
    const db = sb()
    const head = { count: 'exact' as const, head: true }

    const [
      alertsUnacked,
      alertsUrgent,
      latestAlerts,
      queued,
      threshold,
      awaiting,
      failedActions,
      failedValidation,
      failedInfluencer,
      failedAgent,
      activeValidation,
      lastRotation,
    ] = await Promise.all([
      db.from('lume_alerts').select('id', head).is('acked_at', null),
      db.from('lume_alerts').select('id', head).is('acked_at', null).eq('severity', 'urgent'),
      db.from('lume_alerts').select('id,severity,title,created_at').is('acked_at', null).order('created_at', { ascending: false }).limit(5),
      db.from('lead_bank').select('id', head).eq('state', 'queued'),
      getBankThreshold(),
      db.from('pending_actions').select('id,kind,created_at').eq('status', 'awaiting').order('created_at', { ascending: true }).limit(200),
      db.from('pending_actions').select('id', head).eq('status', 'failed').gte('updated_at', since),
      db.from('validation_jobs').select('id', head).eq('status', 'failed').gte('updated_at', since),
      db.from('influencer_runs').select('id', head).eq('status', 'failed').gte('updated_at', since),
      db.from('agent_runs').select('id', head).eq('status', 'failed').gte('created_at', since),
      db.from('validation_jobs').select('id', head).in('status', ['pending', 'processing']),
      db.from('rotation_runs').select('id,ran_at,errors').order('ran_at', { ascending: false }).limit(1),
    ])

    const awaitingRows = must('awaiting', awaiting) as { kind: string; created_at: string }[]
    const byKind: Record<string, number> = {}
    for (const r of awaitingRows) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1
    const queuedN = countOf('lead_bank', queued)
    const rot = (must('rotation', lastRotation) as { ran_at: string; errors: unknown }[])[0]
    const rotErrors = Array.isArray(rot?.errors) ? rot.errors.length : rot?.errors && typeof rot.errors === 'object' ? Object.keys(rot.errors).length : 0

    return {
      data: {
        as_of: now.toISOString(),
        alerts: {
          unacked: countOf('alerts', alertsUnacked),
          urgent: countOf('alerts urgent', alertsUrgent),
          latest: must('latest alerts', latestAlerts),
        },
        lead_bank: { queued: queuedN, threshold, below_threshold: queuedN < threshold },
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
