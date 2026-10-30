import 'server-only'
import { z } from 'zod'
import type { Json, PendingActionKind } from '@/lib/db/types'
import { AttachmentSheetError, ingestSheet, sheetForIngest } from '@/lib/agent/attachmentIngest'
import { attachmentKey } from '@/lib/agent/attachmentActionPayload'

/**
 * `stage_attachment`: the agent's stage_attachment_for_validation. High risk,
 * always asks (it puts leads in front of the validation pipeline, which
 * spends money once the ingest is approved).
 *
 *  build    { file_id, sheet? } → the sheet as it is now: row count, the
 *           email column telegram-inbox will use (none → refused: the
 *           ingest gate could only deny it), and the summary the owner taps.
 *  execute  re-reads the file and the sheet; the row count and email column
 *           must still match what was approved; then the Import CSV path
 *           (`createIngest`), which stops at the usual Approve / Deny ingest
 *           gate. Lume never creates `validation_jobs` or writes pipeline
 *           state here: telegram-inbox does, after the owner's tap.
 */

const fmt = new Intl.NumberFormat('en-US')

const Body = z.object({ file_id: z.string().uuid(), sheet: z.string().min(1).max(200).optional() })

type Build = { ok: true; kind: PendingActionKind; payload: Record<string, Json> & { summary: string } } | { ok: false; status: number; error: string }

export async function buildStageAttachment(raw: Record<string, unknown>): Promise<Build> {
  const body = Body.safeParse(raw)
  if (!body.success) return { ok: false, status: 400, error: 'invalid_payload' }
  let s
  try {
    s = await sheetForIngest(body.data.file_id.toLowerCase(), body.data.sheet ?? null)
  } catch (err) {
    if (err instanceof AttachmentSheetError) return { ok: false, status: err.status, error: err.code }
    throw err
  }
  if (!s.email_column) return { ok: false, status: 422, error: 'no_email_column: the sheet has no email column (or several); the ingest gate could only deny it' }
  return {
    ok: true,
    kind: 'stage_attachment',
    payload: {
      file_id: s.file_id,
      file_name: s.file_name,
      sheet: s.sheet,
      rows: s.rows,
      email_column: s.email_column,
      filename: s.filename,
      attachment_key: attachmentKey(s.file_id, s.sheet),
      summary:
        `Stage ${fmt.format(s.rows)} row${s.rows === 1 ? '' : 's'} from ${s.file_name} · "${s.sheet}" for validation (email column "${s.email_column}"). ` +
        'Approving sends it to the usual Approve / Deny ingest gate as a CSV import; nothing is validated or spent until that gate is approved.',
    },
  }
}

export async function executeStageAttachment(p: Record<string, Json>): Promise<{ ok: true; result: Record<string, Json> } | { ok: false; error: string; result: Record<string, Json> }> {
  const fileId = typeof p.file_id === 'string' ? p.file_id : ''
  const sheetName = typeof p.sheet === 'string' ? p.sheet : ''
  let s
  try {
    s = await sheetForIngest(fileId, sheetName)
  } catch (err) {
    if (err instanceof AttachmentSheetError) return { ok: false, error: `re-check failed: ${err.code}`, result: { file_id: fileId, sheet: sheetName } }
    throw err
  }
  if (s.sheet !== sheetName) return { ok: false, error: 're-check failed: sheet_not_found', result: { file_id: fileId, sheet: sheetName } }
  if (s.rows !== p.rows || s.email_column !== p.email_column) {
    return {
      ok: false,
      error: 're-check failed: the sheet no longer matches what was approved',
      result: { file_id: fileId, sheet: sheetName, rows: s.rows, email_column: s.email_column },
    }
  }
  const r = await ingestSheet(s, `chat attachment ${s.file_name} · ${s.sheet}`)
  return {
    ok: true,
    result: {
      ingest_id: r.ingest.id,
      row_count: r.rowCount,
      email_column: r.detectedColumn,
      telegram: r.telegram,
      gate: `ingest_approval:${r.ingest.id}`,
      note: 'Waiting at the ingest gate (Approve / Deny in Lume Validate or Telegram).',
    },
  }
}
