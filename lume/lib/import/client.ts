/**
 * Browser-side calls for the Import screen. Never throws: a network failure
 * is `{ status: 0 }`. Pure helpers for messages live here too.
 */
import { createClient } from '@/lib/supabase/client'
import { sendJson, type ApiAnswer } from '@/lib/validate/client'

export interface IngestAnswer {
  ok: true
  ingest_id: string
  row_count: number
  email_column: string | null
  telegram: 'sent' | 'skipped' | 'failed'
  gate: string
  items?: number
  truncated?: boolean
  skipped?: number
}

export interface ApolloAnswer {
  ok: true
  order_id: string
  telegram: 'sent' | 'skipped' | 'failed'
  gate: string
}

export function pullApify(body: { dataset_id: string } | { actor_id: string }): Promise<ApiAnswer<IngestAnswer>> {
  return sendJson<IngestAnswer>('/api/import/apify', body, { timeoutMs: 130_000 })
}

export function sendApolloLink(url: string): Promise<ApiAnswer<ApolloAnswer>> {
  return sendJson<ApolloAnswer>('/api/import/apollo-link', { url })
}

interface SignAnswer {
  path: string
  token: string
  signedUrl: string
  upload_ticket: string
}

/**
 * Three steps, so the file never passes through a Vercel function (~4.5 MB
 * body cap): sign → upload straight to Storage → ingest the stored object.
 */
export async function uploadCsvFile(file: File): Promise<ApiAnswer<IngestAnswer>> {
  const sign = await sendJson<SignAnswer>('/api/import/csv/sign', { filename: file.name, size: file.size })
  if (sign.status !== 200 || !sign.body) return sign as unknown as ApiAnswer<IngestAnswer>
  const { path, token, upload_ticket } = sign.body
  try {
    const { error } = await createClient()
      .storage.from('raw-uploads')
      .uploadToSignedUrl(path, token, file, { contentType: 'text/csv' })
    if (error) return { status: 502, body: { error: 'storage' } as unknown as IngestAnswer }
  } catch {
    return { status: 0, body: null }
  }
  return sendJson<IngestAnswer>('/api/import/csv', { storage_path: path, filename: file.name, upload_ticket }, { timeoutMs: 90_000 })
}

/**
 * Import card, .xlsx: the workbook was uploaded and parsed through the chat
 * file routes (`uploadChatFile`); this sends the chosen sheet to the same
 * intake as a CSV upload.
 */
export function importXlsxSheet(fileId: string, sheet: string): Promise<ApiAnswer<IngestAnswer>> {
  return sendJson<IngestAnswer>('/api/import/xlsx', { file_id: fileId, sheet }, { timeoutMs: 90_000 })
}

const MESSAGES: Record<string, string> = {
  invalid_body: 'Enter a valid id.',
  invalid_json: 'Enter a valid id.',
  apify_not_configured: 'Apify is not connected — set APIFY_API_TOKEN.',
  not_found: 'No dataset with that id.',
  no_succeeded_run: 'That actor has no succeeded run.',
  empty_dataset: 'That dataset is empty.',
  apify_error: 'Apify did not answer — try again.',
  too_large: 'Over the 20 MB limit.',
  unsupported_media_type: 'Only .csv or .xlsx files.',
  sheet_not_found: 'That sheet is no longer in the file — upload it again.',
  empty_sheet: 'That sheet has a header but no rows.',
  file_not_found: 'The workbook upload expired — upload it again.',
  not_csv: "That file doesn't read as a CSV.",
  empty_csv: 'The file has a header but no rows.',
  missing_file: 'Choose a file first.',
  invalid_apollo_url: 'Paste an Apollo people search link (https://app.apollo.io/#/people?…).',
  storage: 'Could not save the file — try again.',
  apify_timeout: 'Apify took too long — try again, or pull a smaller dataset.',
  timeout: 'Timed out — check the orders table before retrying.',
  already_ingested: 'That upload was already sent for approval.',
  upload_missing: 'The upload did not arrive — try again.',
  invalid_ticket: 'Upload expired — try again.',
  database: 'Could not save — try again.',
  unauthenticated: 'Your session ended — sign in again.',
}

/** A failed answer → one line for the card. */
export function errorMessage(a: Pick<ApiAnswer, 'status' | 'body' | 'aborted'>): string {
  if (a.status === 0) return a.aborted ? 'Timed out — check the orders table before retrying.' : 'Network error — try again.'
  const code = (a.body as { error?: string } | null)?.error
  if (code && MESSAGES[code]) return MESSAGES[code]
  if (a.status === 413) return 'Over the upload limit.'
  return `Failed (HTTP ${a.status}).`
}

/** Where the new intake's prompt went, for the success line. */
export function promptLine(telegram: 'sent' | 'skipped' | 'failed'): string {
  if (telegram === 'sent') return 'Prompt sent to Telegram — decide there or in Validate.'
  if (telegram === 'skipped') return 'Telegram not configured — decide it in Validate.'
  return 'Telegram prompt failed — decide it in Validate.'
}
