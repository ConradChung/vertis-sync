import type { Json } from '@/lib/db/types'

/** Pure check for the `stage_attachment` pending action (used by createAction). */

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** One awaiting action per file + sheet (pending_actions_one_awaiting_stage_attachment_idx). */
export const STAGE_ATTACHMENT_KEY = 'attachment_key'
export const attachmentKey = (fileId: string, sheet: string) => `${fileId}:${sheet}`

/** null when the snapshot carries what the executor re-checks and the card shows. */
export function stageAttachmentPayloadError(p: Record<string, Json>): string | null {
  if (typeof p.file_id !== 'string' || !LOWER_UUID.test(p.file_id)) return 'payload.file_id must be a lowercase uuid'
  if (typeof p.sheet !== 'string' || !p.sheet) return 'payload.sheet is required'
  if (typeof p.rows !== 'number' || !Number.isInteger(p.rows) || p.rows < 1) return 'payload.rows must be a positive integer'
  if (p.attachment_key !== attachmentKey(p.file_id, p.sheet)) return 'payload.attachment_key must be <file_id>:<sheet>'
  return null
}
