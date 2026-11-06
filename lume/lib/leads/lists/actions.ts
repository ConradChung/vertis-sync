import 'server-only'
import { z } from 'zod'
import type { Json, PendingActionKind } from '@/lib/db/types'
import { createIngest } from '@/lib/import/ingest'
import { MAX_CSV_BYTES } from '@/lib/import/csv'
import { claimSend, countWhere, deleteItems, deleteList, emailCsv, getList, markSent, MISSING, releaseSend, removeWhere, SendTooLarge, type LeadList } from '@/lib/leads/lists/store'

/**
 * send_lead_list: a lead list → the Import CSV path. The rows that carry an
 * email are written as CSV (read page by page) and handed to `createIngest`,
 * which uploads it to `raw-uploads`, inserts a `telegram_ingests` row
 * `awaiting_approval` and sends the usual Approve / Approve + Enrich / Deny
 * prompt. telegram-inbox creates the validation job after the owner's tap;
 * Lume never creates `validation_jobs` and nothing is spent before that gate.
 *  - the agent's send_lead_list_to_validation: always-ask approval
 *    (build → owner taps → execute re-checks the list is as approved);
 *  - the Leads page: an owner click with a confirm (`sendLeadListNow`).
 * delete_lead_list: the agent's delete_lead_list, always asks.
 */

const fmt = new Intl.NumberFormat('en-US')
const Body = z.object({ list_id: z.string().uuid() })

type Fail = { ok: false; status: number; error: string }
type Build = { ok: true; kind: PendingActionKind; payload: Record<string, Json> & { summary: string } } | Fail
type Exec = { ok: true; result: Record<string, Json> } | { ok: false; error: string; result: Record<string, Json> }

const rowsWord = (n: number) => `${fmt.format(n)} row${n === 1 ? '' : 's'}`

/** Why this list cannot go to validation now, or null. */
function refusal(list: LeadList | null): Fail | null {
  if (!list) return { ok: false, status: 404, error: 'list_not_found' }
  if (list.email_count < 1) return { ok: false, status: 422, error: `no_emails: 0 of ${fmt.format(list.item_count)} rows have an email` }
  // Rows unchanged since the last send (content_changed_at moves only on a real add / remove / edit).
  if (list.sent_at && list.sent_at >= list.content_changed_at) return { ok: false, status: 409, error: 'already_sent' }
  return null
}

export async function buildSendLeadList(raw: Record<string, unknown>): Promise<Build> {
  const body = Body.safeParse(raw)
  if (!body.success) return { ok: false, status: 400, error: 'invalid_payload' }
  const list = await getList(body.data.list_id.toLowerCase())
  const no = refusal(list)
  if (no) return no
  const l = list!
  return {
    ok: true,
    kind: 'send_lead_list',
    payload: {
      list_id: l.id,
      name: l.name,
      rows: l.item_count,
      email_rows: l.email_count,
      list_changed_at: l.content_changed_at,
      summary:
        `Send lead list "${l.name}" to validation: ${fmt.format(l.email_count)} of ${rowsWord(l.item_count)} have an email and go as a CSV import. ` +
        'Approving sends it to the usual Approve / Deny ingest gate; nothing is validated or spent until that gate is approved.',
    },
  }
}

/** Claim the send (atomic, before anything else), build the CSV, ingest; a failure releases the claim. */
async function ingestList(l: LeadList): Promise<Exec> {
  const claim = await claimSend(l.id)
  if (!claim.claimed) return { ok: false, error: 'already_sent', result: { list_id: l.id } }
  let r, rows
  try {
    let built
    try {
      built = await emailCsv(l.id)
    } catch (err) {
      if (err instanceof SendTooLarge) {
        await releaseSend(l.id, claim.prev_sent_at)
        return { ok: false, error: 'too_large: the list is over the 20 MB CSV limit', result: { list_id: l.id } }
      }
      throw err
    }
    rows = built.rows
    const bytes = new TextEncoder().encode(built.csv)
    if (bytes.byteLength > MAX_CSV_BYTES) {
      await releaseSend(l.id, claim.prev_sent_at)
      return { ok: false, error: 'too_large', result: { list_id: l.id, rows } }
    }
    const filename = `${l.name.replace(/[\\/\u0000-\u001f]+/g, ' ').slice(0, 190)}.csv`
    r = await createIngest(bytes, filename, { source: 'csv', detail: `lead list ${l.name}` })
  } catch (err) {
    await releaseSend(l.id, claim.prev_sent_at).catch(() => {})
    throw err
  }
  await markSent(l.id, r.ingest.id, rows)
  return {
    ok: true,
    result: {
      list_id: l.id,
      ingest_id: r.ingest.id,
      rows,
      email_column: r.detectedColumn,
      telegram: r.telegram,
      gate: `ingest_approval:${r.ingest.id}`,
      note: 'Waiting at the ingest gate (Approve / Deny in Lume Validate or Telegram).',
    },
  }
}

export async function executeSendLeadList(p: Record<string, Json>): Promise<Exec> {
  const listId = typeof p.list_id === 'string' ? p.list_id : ''
  const list = await getList(listId)
  const no = refusal(list)
  if (no) return { ok: false, error: `re-check failed: ${no.error}`, result: { list_id: listId } }
  if (list!.email_count !== p.email_rows || list!.content_changed_at !== p.list_changed_at) {
    return { ok: false, error: 're-check failed: the list changed since it was approved', result: { list_id: listId, email_rows: list!.email_count } }
  }
  return ingestList(list!)
}

/** The Leads page's button (the owner already confirmed in the page). */
export async function sendLeadListNow(listId: string): Promise<Exec | Fail> {
  const list = await getList(listId)
  const no = refusal(list)
  if (no) return no
  return ingestList(list!)
}

export async function buildDeleteLeadList(raw: Record<string, unknown>): Promise<Build> {
  const body = Body.safeParse(raw)
  if (!body.success) return { ok: false, status: 400, error: 'invalid_payload' }
  const list = await getList(body.data.list_id.toLowerCase())
  if (!list) return { ok: false, status: 404, error: 'list_not_found' }
  return {
    ok: true,
    kind: 'delete_lead_list',
    payload: { list_id: list.id, name: list.name, rows: list.item_count, summary: `Delete lead list "${list.name}" and its ${rowsWord(list.item_count)}. This cannot be undone.` },
  }
}

export async function executeDeleteLeadList(p: Record<string, Json>): Promise<Exec> {
  const listId = typeof p.list_id === 'string' ? p.list_id : ''
  const deleted = await deleteList(listId)
  return deleted ? { ok: true, result: { list_id: listId, deleted: true } } : { ok: false, error: 'list_not_found', result: { list_id: listId } }
}

/** remove_lead_rows: the agent's bulk removal from a list (q, missing, or more than 25 rows), always asks. */
const RemoveBody = z
  .object({ list_id: z.string().uuid(), idxs: z.array(z.number().int().min(0)).max(20_000).optional(), missing: z.array(z.enum(MISSING)).max(4).optional(), q: z.string().min(2).max(120).optional() })
  .refine((v) => !!v.idxs?.length || !!v.missing?.length || !!v.q, 'idxs, missing or q')

export async function buildRemoveLeadRows(raw: Record<string, unknown>): Promise<Build> {
  const body = RemoveBody.safeParse(raw)
  if (!body.success) return { ok: false, status: 400, error: 'invalid_payload' }
  const list = await getList(body.data.list_id.toLowerCase())
  if (!list) return { ok: false, status: 404, error: 'list_not_found' }
  const { idxs, missing, q } = body.data
  const matching = (idxs?.length ?? 0) + (missing?.length || q ? await countWhere(list.id, { missing, q }) : 0)
  if (!matching) return { ok: false, status: 422, error: 'nothing_to_remove' }
  const what = [idxs?.length ? `${fmt.format(idxs.length)} chosen row${idxs.length === 1 ? '' : 's'}` : '', missing?.length ? `rows missing ${missing.join(' / ')}` : '', q ? `rows matching "${q}"` : ''].filter(Boolean).join(', ')
  return {
    ok: true,
    kind: 'remove_lead_rows',
    payload: {
      list_id: list.id,
      name: list.name,
      rows: list.item_count,
      ...(idxs?.length ? { idxs } : {}),
      ...(missing?.length ? { missing } : {}),
      ...(q ? { q } : {}),
      matching,
      summary: `Remove ${what} from lead list "${list.name}": about ${fmt.format(Math.min(matching, list.item_count))} of its ${rowsWord(list.item_count)}. This cannot be undone.`,
    },
  }
}

export async function executeRemoveLeadRows(p: Record<string, Json>): Promise<Exec> {
  const body = RemoveBody.safeParse(p)
  if (!body.success) return { ok: false, error: 'invalid_payload', result: {} }
  const list = await getList(body.data.list_id)
  if (!list) return { ok: false, error: 'list_not_found', result: { list_id: body.data.list_id } }
  let removed = 0
  if (body.data.idxs?.length) removed += await deleteItems(list.id, body.data.idxs)
  if (body.data.missing?.length || body.data.q) removed += await removeWhere(list.id, { missing: body.data.missing, q: body.data.q })
  return { ok: true, result: { list_id: list.id, removed } }
}
