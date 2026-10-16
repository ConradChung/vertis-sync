'use client'

import useSWR from 'swr'
import { fetchJson } from '@/hooks/fetcher'
import { useRealtimeInvalidate, type RealtimeChange } from '@/hooks/useRealtimeInvalidate'
import type { GateRow } from '@/lib/db/types'

const PIPELINE_PREFIXES = ['validation_jobs.', 'telegram_ingests.', 'job_batches.', 'apollo_orders.', 'lume.']

/**
 * Gates open and close on status changes of the pipeline tables (the DB
 * triggers write `<table>.<column>` / `<table>.inserted` events) and on
 * Lume's own `lume.*` events. Every `pending_actions` change counts (the
 * `lume_action` kind). Instantly webhooks, rotation runs etc. do not refetch.
 */
export function validationRelevant({ table, record }: RealtimeChange): boolean {
  if (table === 'pending_actions') return true
  if (table !== 'events') return false
  const type = typeof record.type === 'string' ? record.type : ''
  return PIPELINE_PREFIXES.some((p) => type.startsWith(p))
}

/** Open gates from `GET /api/gates` (the `lume_gates` view), plus a slow poll. */
export function useValidationQueue() {
  const swr = useSWR<GateRow[]>('/api/gates', fetchJson, {
    refreshInterval: 30_000,
    keepPreviousData: true,
  })
  useRealtimeInvalidate(() => void swr.mutate(), {
    tables: ['events', 'pending_actions'],
    filter: validationRelevant,
    throttleMs: 2_000,
  })
  return swr
}
