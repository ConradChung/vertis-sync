'use client'

import useSWR from 'swr'
import { fetchJson } from '@/hooks/fetcher'
import type { JobProgress, PushPreview } from '@/lib/db/types'
import type { InstantlyCampaign } from '@/lib/adapters/instantly.map'
import type { ValidationRowView } from '@/lib/validate/rows'

export const jobKey = (id: string) => `/api/jobs/${id}`
export const rowsKey = (id: string, page: number) => `/api/jobs/${id}/rows?page=${page}`
export const previewKey = (id: string) => `/api/gates/campaign/${id}`

const RUNNING = new Set(['pending', 'processing'])

/** Job progress; polls every 5 s while the validator is running, else 60 s. */
export function useJobProgress(id: string | null) {
  return useSWR<JobProgress>(id ? jobKey(id) : null, fetchJson, {
    keepPreviousData: true,
    refreshInterval: (data) => (data && RUNNING.has(data.status ?? '') ? 5_000 : 60_000),
  })
}

export interface RowsPage {
  rows: ValidationRowView[]
  total: number
  page: number
  pageSize: number
  editable: boolean
  edit_block_reason: string | null
}

export function useJobRows(id: string | null, page: number) {
  return useSWR<RowsPage>(id ? rowsKey(id, page) : null, fetchJson, { keepPreviousData: true })
}

/** `instantly-push` preview — computed from the barriers on the job row. */
export function usePushPreview(id: string | null) {
  return useSWR<{ preview: PushPreview }>(id ? previewKey(id) : null, fetchJson, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  })
}

export type CampaignsAnswer = { configured: false } | { configured: true; campaigns: InstantlyCampaign[] }

export function useInstantlyCampaigns(enabled: boolean) {
  return useSWR<CampaignsAnswer>(enabled ? '/api/instantly/campaigns' : null, fetchJson, {
    revalidateOnFocus: false,
  })
}
