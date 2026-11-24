/**
 * Browser-side calls for the Google Maps card (GTM-12) on Import. Never
 * throws: a network failure is `{ status: 0 }`. Messages are pure helpers.
 */
import { sendJson, type ApiAnswer } from '@/lib/validate/client'

export interface ScrapeAnswer {
  ok: true
  action: { id: string; kind: string; summary: string }
  areas: number
  dropped_fields: string[]
}

export interface SheetAnswer {
  ok: true
  list_id: string
  list_name: string
  href: string
  summary: string
  truncated: boolean
  run_status: string | null
  append: { added: number; duplicates: number; over_cap: number; item_count: number }
  clean: { kept: number; with_phone: number; pm_category: number; total: number }
}

export function requestMapsScrape(body: { per_search?: number; regions?: string[]; areas?: string[] } = {}): Promise<ApiAnswer<ScrapeAnswer>> {
  return sendJson<ScrapeAnswer>('/api/maps/scrape', body, { timeoutMs: 60_000 })
}

export function buildMapsSheetFrom(runId: string): Promise<ApiAnswer<SheetAnswer>> {
  return sendJson<SheetAnswer>('/api/maps/sheet', { run_id: runId.trim() }, { timeoutMs: 130_000 })
}

/** Apify run ids are 8–40 letters and digits (the action's result shows it). */
export const isRunId = (v: string) => /^[A-Za-z0-9]{8,40}$/.test(v.trim())

const MESSAGES: Record<string, string> = {
  apify_not_configured: 'Apify is not connected — set APIFY_API_TOKEN.',
  duplicate: 'The same scrape is already waiting for your approval.',
  not_found: 'No Apify run with that id.',
  run_has_no_dataset: 'That run has no dataset.',
  empty_dataset: "That run's dataset is empty.",
  not_a_maps_dataset: "That run isn't a Google Maps scrape.",
  list_busy: 'The list is busy — try again in a moment.',
  bad_run_id: 'Enter a valid Apify run id.',
}

export function mapsErrorMessage(a: Pick<ApiAnswer, 'status' | 'body' | 'aborted'>): string {
  if (a.status === 0) return a.aborted ? 'Timed out — check Leads → Lists before retrying.' : 'Network error — try again.'
  const code = (a.body as { error?: string } | null)?.error ?? ''
  if (MESSAGES[code]) return MESSAGES[code]
  if (code.startsWith('run_not_finished')) return `The run hasn't finished yet (${code.split(': ')[1]?.toLowerCase() ?? 'running'}).`
  if (code.startsWith('nothing_kept')) return `No company survived cleaning: ${code.slice('nothing_kept: '.length)}`
  if (code.startsWith('not_runnable') || code.startsWith('invalid_input')) return `Apify refused the request: ${code}`
  return code ? `Failed (${code}).` : `Failed (HTTP ${a.status}).`
}

/** "412 companies, 398 with a phone. 1,980 places → …" */
export function sheetLine(b: SheetAnswer): string {
  const n = (x: number) => x.toLocaleString('en-US')
  const partial = b.run_status && b.run_status !== 'SUCCEEDED' ? ` The run ended ${b.run_status.toLowerCase()}, so the sheet is partial.` : ''
  const cut = b.truncated ? ' Only the first 20,000 places were read.' : ''
  const full = b.append.over_cap ? ` ${n(b.append.over_cap)} more did not fit the list.` : ''
  return `${n(b.append.added)} companies in “${b.list_name}”, ${n(b.clean.with_phone)} with a phone. ${b.summary}${partial}${cut}${full}`
}
