import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { MAX_FILE_BYTES } from '@/lib/agent/projectModel'

/**
 * The private `agent-projects` bucket (service role). Objects live at
 * `<project_id>/<uuid>.<ext>`; the browser uploads to a one-time signed URL
 * (so files never pass through a Vercel function's ~4.5 MB body cap), the
 * finalize route reads it back once to extract text. The bucket itself caps
 * objects at 20 MB.
 */

export const PROJECT_BUCKET = 'agent-projects'

/** `<project uuid>/<uuid>.<ext>`: the only paths the finalize route accepts. */
export const PROJECT_UPLOAD_PATH = /^([0-9a-f-]{36})\/[0-9a-f-]{36}\.([a-z0-9]{1,8})$/

export class ProjectStorageError extends Error {
  constructor(op: string, detail: string) {
    super(`agent-projects ${op}: ${detail.slice(0, 200)}`)
    this.name = 'ProjectStorageError'
  }
}

export async function signProjectUpload(path: string): Promise<{ token: string; signedUrl: string }> {
  const { data, error } = await createServiceClient().storage.from(PROJECT_BUCKET).createSignedUploadUrl(path)
  if (error || !data) throw new ProjectStorageError('sign', error?.message ?? 'no data')
  return { token: data.token, signedUrl: data.signedUrl }
}

/** The object's bytes, `null` when missing, `'too_large'` past the cap. */
export async function downloadProjectObject(path: string, maxBytes = MAX_FILE_BYTES): Promise<Uint8Array | null | 'too_large'> {
  const { data, error } = await createServiceClient().storage.from(PROJECT_BUCKET).download(path)
  if (error || !data) {
    const status = (error as { status?: number; statusCode?: string } | null)?.status
    if (status === 400 || status === 404 || /not.?found/i.test(error?.message ?? '')) return null
    throw new ProjectStorageError('download', error?.message ?? 'no data')
  }
  if (data.size > maxBytes) return 'too_large'
  return new Uint8Array(await data.arrayBuffer())
}

/** Best effort: a failed removal is logged, never thrown. */
export async function removeProjectObjects(paths: string[]): Promise<void> {
  if (!paths.length) return
  try {
    const { error } = await createServiceClient().storage.from(PROJECT_BUCKET).remove(paths)
    if (error) console.error('[agent-projects] remove failed:', error.message)
  } catch (err) {
    console.error('[agent-projects] remove failed:', err instanceof Error ? err.message : err)
  }
}
