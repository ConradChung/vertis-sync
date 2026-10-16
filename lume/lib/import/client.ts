/**
 * Browser-side calls for the Import screen. Never throws: a network failure
 * is `{ status: 0 }`. Pure helpers for messages live here too.
 */
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

export async function uploadCsvFile(file: File): Promise<ApiAnswer<IngestAnswer>> {
  const form = new FormData()
  form.append('file', file, file.name)
  try {
    const res = await fetch('/api/import/csv', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      body: form,
      signal: AbortSignal.timeout(90_000),
    })
    return { status: res.status, body: (await res.json().catch(() => null)) as IngestAnswer | null }
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    return { status: 0, body: null, aborted: name === 'TimeoutError' || name === 'AbortError' }
  }
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
  unsupported_media_type: 'Only .csv files.',
  not_csv: "That file doesn't read as a CSV.",
  empty_csv: 'The file has a header but no rows.',
  missing_file: 'Choose a file first.',
  invalid_apollo_url: 'Paste an Apollo people search link (https://app.apollo.io/#/people?…).',
  storage: 'Could not save the file — try again.',
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
