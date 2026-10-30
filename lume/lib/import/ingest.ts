import 'server-only'
import { sendMessage, type TelegramResult } from '@/lib/adapters/telegram'
import { alert, alertLink, gateKey, telegramSkipped, titleFrom } from '@/lib/alerts'
import {
  insertApolloOrder,
  insertIngest,
  logEvent,
  setApolloOrderMessageId,
  setIngestMessageId,
} from '@/lib/db/service'
import type { ApolloOrderRow, TelegramIngestRow } from '@/lib/db/types'
import { countDataRows, detectedEmailColumn, headerFromBytes, parseCSVRow } from '@/lib/import/csv'
import {
  APOLLO_PROMPT_TEXT,
  ingestKeyboard,
  ingestPromptText,
  LUME_SENDER_NAME,
  lfoCountKeyboard,
} from '@/lib/import/messages'
import { removeObject, uploadCsv } from '@/lib/import/storage'

/**
 * Lume's intakes enter the EXISTING approval gate and stop there.
 *
 * `createIngest` does what telegram-inbox's `handleDocument` does for a file
 * dropped in the chat: upload to `raw-uploads`, insert a `telegram_ingests`
 * row `awaiting_approval`, send the owner the same prompt and keyboard, store
 * the message id. Approve / Approve + Enrich / Deny then run in telegram-inbox
 * (tapped in Telegram, or from Validate through `/api/gates/decide`), which
 * creates the validation job. Lume never creates `validation_jobs`.
 *
 * `createApolloOrder` mirrors `handleApolloOrPasteText` for an Apollo people
 * search: an `apollo_orders` row `awaiting_count` and the count prompt. The
 * count is chosen in Telegram or in Lume's rail (`lfo_count:<id>:<n>`).
 *
 * Telegram unconfigured: the row still exists (it shows as a gate in
 * Validate and is approved from Lume); `telegram` is `skipped`.
 */

export type PromptOutcome = 'sent' | 'skipped' | 'failed'

export interface IngestMeta {
  source: 'csv' | 'apify'
  /** Free-text origin for the event feed (dataset id, actor id, file name). */
  detail?: string
  /** The route's shared deadline (covers the upload). */
  signal?: AbortSignal
  /**
   * A fixed `lume/<uuid>.csv` instead of a random one (an attached sheet's,
   * derived from file + sheet): the upload is exclusive, so a second ingest
   * of the same sheet fails at Storage instead of creating a duplicate.
   */
  storagePath?: string
}

export interface IngestResult {
  ingest: TelegramIngestRow
  detectedColumn: string | null
  rowCount: number
  telegram: PromptOutcome
}

const outcome = (r: TelegramResult): PromptOutcome => (r.ok ? 'sent' : r.skipped ? 'skipped' : 'failed')

/** `telegram_ingests.telegram_chat_id` / `sender_chat_id` are NOT NULL; the owner chat, or a marker without one. */
function ownerChatId(): string {
  return process.env.TELEGRAM_CHAT_ID?.trim() || 'lume'
}

async function feed(type: string, title: string, sourceId: string, payload: Record<string, string | number | null>) {
  try {
    await logEvent({ type, source: 'lume', source_id: sourceId, title, payload })
  } catch (err) {
    console.error('[import] event log failed:', err instanceof Error ? err.message : err)
  }
}

/**
 * Upload the bytes, then ingest them (Apify: the CSV is generated here). An
 * ingest row that cannot be written removes the upload again.
 */
export async function createIngest(csvBytes: Uint8Array, filename: string, meta: IngestMeta): Promise<IngestResult> {
  const storagePath = meta.storagePath ?? `lume/${crypto.randomUUID()}.csv`
  await uploadCsv(storagePath, csvBytes, meta.signal)
  try {
    return await createIngestForStoredObject(storagePath, filename, csvBytes, countDataRows(csvBytes), meta)
  } catch (err) {
    // Only the insert throws (the prompt, message id and feed never do).
    await removeObject(storagePath)
    throw err
  }
}

/**
 * Ingest an object already in `raw-uploads` (the browser's signed upload, or
 * `createIngest`'s own). `headerBytes` needs only the first line; `rowCount`
 * is telegram-inbox's newline count over the whole file.
 */
export async function createIngestForStoredObject(
  storagePath: string,
  filename: string,
  headerBytes: Uint8Array,
  rowCount: number,
  meta: IngestMeta
): Promise<IngestResult> {
  // Header straight off the bytes, exactly as telegram-inbox reads it (not
  // BOM-stripped there either, so detection names the same column the
  // approval step will look up).
  const headers = parseCSVRow(headerFromBytes(headerBytes))
  const detectedColumn = detectedEmailColumn(headers)

  const chatId = ownerChatId()
  let ingest = await insertIngest({
    sender_platform: 'lume',
    telegram_chat_id: chatId,
    sender_chat_id: chatId,
    sender_name: LUME_SENDER_NAME,
    filename,
    storage_path: storagePath,
    row_count: rowCount,
    detected_email_column: detectedColumn,
    status: 'awaiting_approval',
  })

  // The approval gate: always in the feed, and the same Telegram prompt as
  // before while ALERT_CHANNELS includes telegram.
  const promptText = ingestPromptText({ filename, rowCount, detectedColumn })
  const ingestId = ingest.id
  const sent = (await alert({
    source: 'lume.import', severity: 'urgent', title: titleFrom(promptText), body: promptText,
    link: alertLink(`/validate?gate=ingest_approval:${ingestId}`), scope: 'validation',
    dedupe_key: gateKey(ingestId, 'ingest_approval'),
    telegram: () => sendMessage(promptText, {
      replyMarkup: ingestKeyboard(ingestId, detectedColumn),
    }),
  })) ?? telegramSkipped
  if (sent.ok && sent.messageId !== null) {
    try {
      await setIngestMessageId(ingest.id, sent.messageId)
      ingest = { ...ingest, telegram_message_id: sent.messageId }
    } catch (err) {
      // The ingest and prompt both exist; a missing id only means the
      // Telegram message is not edited when the gate is decided.
      console.error('[import] could not store telegram_message_id:', err instanceof Error ? err.message : err)
    }
  }

  await feed('lume.import', `${meta.source === 'apify' ? 'Apify pull' : 'CSV upload'} · ${rowCount} rows`, ingest.id, {
    source: meta.source,
    detail: meta.detail ?? filename,
    rows: rowCount,
    email_column: detectedColumn,
  })

  return { ingest, detectedColumn, rowCount, telegram: outcome(sent) }
}

export interface ApolloOrderResult {
  order: ApolloOrderRow
  telegram: PromptOutcome
}

export async function createApolloOrder(apolloUrl: string): Promise<ApolloOrderResult> {
  let order = await insertApolloOrder(apolloUrl)
  const orderId = order.id
  const sent = (await alert({
    source: 'lume.import', severity: 'urgent', title: titleFrom(APOLLO_PROMPT_TEXT), body: APOLLO_PROMPT_TEXT,
    link: alertLink(`/validate?gate=lfo_count:${orderId}`), scope: 'orders',
    dedupe_key: gateKey(orderId, 'lfo_count'),
    telegram: () => sendMessage(APOLLO_PROMPT_TEXT, { replyMarkup: lfoCountKeyboard(orderId), disablePreview: true }),
  })) ?? telegramSkipped
  if (sent.ok && sent.messageId !== null) {
    try {
      await setApolloOrderMessageId(order.id, sent.messageId)
      order = { ...order, telegram_message_id: sent.messageId }
    } catch (err) {
      console.error('[import] could not store apollo telegram_message_id:', err instanceof Error ? err.message : err)
    }
  }
  await feed('lume.import', 'Apollo link · waiting on count', order.id, { source: 'apollo_link' })
  return { order, telegram: outcome(sent) }
}
