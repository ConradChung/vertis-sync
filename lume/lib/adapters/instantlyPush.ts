import 'server-only'
import type { PushPreview } from '@/lib/db/types'

/**
 * The `instantly-push` edge function's read-only preview (`mode: 'preview'`):
 * eligible/filtered counts and the first normalized company names, computed
 * from the barriers on the job row. The same call telegram-inbox's company
 * review makes, so the names shown are the names that would be pushed.
 *
 * Never calls the push itself (no `mode` = push). Service role, server-only.
 */

export const PREVIEW_TIMEOUT_MS = 60_000

export type PreviewResult = { ok: true; preview: PushPreview } | { ok: false; error: string }

export async function getPushPreview(jobId: string): Promise<PreviewResult> {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, '')
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!base || !key) return { ok: false, error: 'not_configured' }
  try {
    const res = await fetch(`${base}/functions/v1/instantly-push`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: jobId, mode: 'preview' }),
      signal: AbortSignal.timeout(PREVIEW_TIMEOUT_MS),
      cache: 'no-store',
    })
    const json = (await res.json().catch(() => null)) as PushPreview | null
    if (!res.ok || !json || json.ok !== true) {
      console.error(`[instantly-push preview] HTTP ${res.status}: ${json?.error ?? 'bad body'}`)
      return { ok: false, error: 'preview_failed' }
    }
    return { ok: true, preview: json }
  } catch (err) {
    console.error('[instantly-push preview]', err instanceof Error ? err.message : err)
    return { ok: false, error: 'preview_failed' }
  }
}
