import 'server-only'
import { sendMessage, type TelegramResult } from '@/lib/adapters/telegram'
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

export async function createIngest(csvBytes: Uint8Array, filename: string, meta: IngestMeta): Promise<IngestResult> {
  // Header and row count straight off the bytes, exactly as telegram-inbox
  // reads them (the header is not BOM-stripped there either, so detection
  // names the same column the approval step will look up).
  const headers = parseCSVRow(headerFromBytes(csvBytes))
  const rowCount = countDataRows(csvBytes)
  const detectedColumn = detectedEmailColumn(headers)

  const storagePath = `lume/${crypto.randomUUID()}.csv`
  await uploadCsv(storagePath, csvBytes)

  const chatId = ownerChatId()
  let ingest: TelegramIngestRow
  try {
    ingest = await insertIngest({
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
  } catch (err) {
    await removeObject(storagePath)
    throw err
  }

  const sent = await sendMessage(ingestPromptText({ filename, rowCount, detectedColumn }), {
    replyMarkup: ingestKeyboard(ingest.id, detectedColumn),
  })
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
  const sent = await sendMessage(APOLLO_PROMPT_TEXT, { replyMarkup: lfoCountKeyboard(order.id), disablePreview: true })
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
