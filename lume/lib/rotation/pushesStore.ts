import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { DbError } from '@/lib/db/service'
import type { Json } from '@/lib/db/types'
import { BANK_QUEUE_KEY, BankQueueBody, NO_SOURCE_NAME, pushKey, type PushRow } from '@/lib/rotation/pushes'

/** Reads and writes behind Rotate → Pushes (lume_lead_bank_pushes / lume_lead_bank_queue_op). */

const fmt = new Intl.NumberFormat('en-US')
const leads = (k: number) => `${fmt.format(k)} lead${k === 1 ? '' : 's'}`

export async function listPushRows(): Promise<PushRow[]> {
  const res = await createServiceClient().rpc('lume_lead_bank_pushes')
  if (res.error) throw new DbError('listPushRows', res.error)
  return (res.data ?? []) as PushRow[]
}

async function pushRow(jobId: string | null, campaignId: string): Promise<PushRow | null> {
  return (await listPushRows()).find((r) => r.source_job_id === jobId && r.campaign_id === campaignId) ?? null
}

async function queueOp(jobId: string | null, campaignId: string, op: 'stop' | 'restart' | 'move', to: string | null = null): Promise<{ changed: number; kept: number }> {
  const res = await createServiceClient().rpc('lume_lead_bank_queue_op', { p_job: jobId, p_campaign: campaignId, p_op: op, p_to: to })
  if (res.error) throw new DbError(`lead bank ${op}`, res.error)
  const d = (res.data ?? {}) as { changed?: number; kept?: number }
  return { changed: Number(d.changed) || 0, kept: Number(d.kept) || 0 }
}

/** Stop one push's queue for one campaign now: its queued leads leave the rotation (restartable). */
export async function stopPush(jobId: string | null, campaignId: string): Promise<{ stopped: number }> {
  const { changed } = await queueOp(jobId, campaignId, 'stop')
  return { stopped: changed }
}

type Build = { ok: true; kind: 'bank_queue'; payload: Record<string, Json> & { summary: string } } | { ok: false; status: number; error: string }

/** bank_queue: restart a push's stopped leads, or move its queued ones to another campaign, frozen with today's count. */
export async function buildBankQueue(raw: Record<string, unknown>, campaignName: (id: string) => Promise<string>): Promise<Build> {
  const body = BankQueueBody.safeParse(raw)
  if (!body.success) return { ok: false, status: 400, error: 'invalid_payload' }
  const { op, source_job_id: jobId, campaign_id: campaignId, to_campaign_id: to } = body.data
  const row = await pushRow(jobId, campaignId)
  if (!row) return { ok: false, status: 404, error: 'push_not_found' }
  const count = op === 'restart' ? Number(row.stopped) : Number(row.queued)
  if (!count) return { ok: false, status: 422, error: op === 'restart' ? 'nothing_stopped' : 'nothing_queued' }
  const list = jobId ? (row.job_name ?? row.filename ?? jobId) : NO_SOURCE_NAME
  const from = await campaignName(campaignId)
  const target = to ? await campaignName(to) : null
  const summary =
    op === 'restart'
      ? `Restart rotation for ${leads(count)} from ${list} → ${from}. They go back in the queue and rotate into Instantly as slots free.`
      : `Move ${leads(count)} queued from ${list}: ${from} → ${target}. They rotate into ${target} as slots free; leads already in ${target} stay put.`
  return {
    ok: true,
    kind: 'bank_queue',
    payload: {
      op,
      source_job_id: jobId,
      campaign_id: campaignId,
      campaign_name: from,
      ...(to ? { to_campaign_id: to, to_campaign_name: target } : {}),
      list_name: list,
      count,
      [BANK_QUEUE_KEY]: pushKey(jobId, campaignId),
      summary,
    },
  }
}

export async function executeBankQueue(p: Record<string, Json>): Promise<Record<string, Json>> {
  const op = p.op === 'move' ? 'move' : 'restart'
  const jobId = typeof p.source_job_id === 'string' ? p.source_job_id : null
  const out = await queueOp(jobId, String(p.campaign_id), op, op === 'move' ? String(p.to_campaign_id) : null)
  return { op, changed: out.changed, ...(op === 'move' ? { kept: out.kept } : {}) }
}
