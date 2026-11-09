'use client'

import useSWR from 'swr'
import { fetchJson } from '@/hooks/fetcher'
import type { JobProgress, PushPreview } from '@/lib/db/types'
import type { InstantlyCampaign } from '@/lib/adapters/instantly.map'
import { jobsPollInterval, type JobSummary } from '@/lib/validate/jobs'

export const jobKey = (id: string) => `/api/jobs/${id}`
export const previewKey = (id: string) => `/api/gates/campaign/${id}`

const RUNNING = new Set(['pending', 'processing'])

/** Job progress; polls every 5 s while the validator is running, else 60 s. */
export function useJobProgress(id: string | null) {
  return useSWR<JobProgress>(id ? jobKey(id) : null, fetchJson, {
    keepPreviousData: true,
    refreshInterval: (data) => (data && RUNNING.has(data.status ?? '') ? 5_000 : 60_000),
  })
}

type Reason = { status: string; reason: string | null; n: number }

/** Reason counts: once a minute while the job runs; the key changes when it finishes, so the final counts are read once. */
export const reasonsKey = (id: string, status: string | null) => `/api/jobs/${id}/reasons?state=${RUNNING.has(status ?? '') ? 'running' : 'done'}`
export const reasonsRefresh = (status: string | null) => (RUNNING.has(status ?? '') ? 60_000 : 0)

export function useJobReasons(id: string | null, status: string | null | undefined) {
  return useSWR<{ reasons: Reason[] }>(id && status !== undefined ? reasonsKey(id, status) : null, fetchJson, {
    keepPreviousData: true,
    refreshInterval: reasonsRefresh(status ?? null),
    revalidateOnFocus: false,
  })
}

/** The Validate page's "Running" list (`GET /api/jobs`); polls like useJobProgress: 5 s while a job runs, else 60 s. */
export function useRecentJobs() {
  return useSWR<{ jobs: JobSummary[] }>('/api/jobs', fetchJson, { keepPreviousData: true, refreshInterval: jobsPollInterval })
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
