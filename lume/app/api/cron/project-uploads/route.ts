import { NextResponse } from 'next/server'
import { requireSecret } from '@/lib/auth/guards'
import { deletePendingUploads, pathsInUse, stalePendingUploads } from '@/lib/agent/projects'
import { removeProjectObjects } from '@/lib/agent/projectStorage'
import { dbErrorResponse } from '@/lib/http/errors'

/**
 * Target of pg_cron `lume-project-upload-sweep` (hourly, via
 * `lume_project_upload_sweep()` → pg_net, only when there is work), with
 * `X-Lume-Hook-Secret` like the rotation tick. Project files signed but never
 * finalized (an `agent_project_uploads` row over 3 hours old) have their
 * Storage object deleted; a path an item points at is kept (its finalize
 * succeeded but could not clear the row). Up to 200 per run; the rest wait
 * for the next hour. → `{ ok, removed, kept }`; 502 when Storage refused the
 * delete (those rows stay for the next run).
 */
export const maxDuration = 60

/**
 * Signed upload URLs stay valid for 2 h (storage-js createSignedUploadUrl), so
 * a younger row may still get its object: only rows past 3 h are orphans.
 * lume_project_upload_sweep() uses the same 3 h.
 */
export const STALE_UPLOAD_MS = 3 * 60 * 60 * 1000

export async function POST(req: Request) {
  const auth = requireSecret(req, 'X-Lume-Hook-Secret', 'LUME_HOOK_SECRET')
  if (!auth.ok) return auth.response
  try {
    const stale = await stalePendingUploads(new Date(Date.now() - STALE_UPLOAD_MS))
    const inUse = await pathsInUse(stale)
    const orphans = stale.filter((p) => !inUse.has(p))
    // A failed Storage delete keeps the orphans' rows, so the next run retries them.
    const removed = await removeProjectObjects(orphans)
    await deletePendingUploads(removed ? stale : stale.filter((p) => inUse.has(p)))
    return NextResponse.json({ ok: removed, removed: removed ? orphans.length : 0, kept: stale.length - orphans.length }, { status: removed ? 200 : 502 })
  } catch (err) {
    return dbErrorResponse(err, 'api/cron/project-uploads')
  }
}
