'use client'

import useSWR from 'swr'
import { fetchJson } from '@/hooks/fetcher'
import { useRealtimeInvalidate } from '@/hooks/useRealtimeInvalidate'
import type { CampaignActionKind } from '@/lib/actions/payloads'
import type {
  CampaignAnalyticsResponse,
  CampaignFlowResponse,
  CampaignInboxResponse,
  CampaignTableResponse,
} from '@/lib/campaigns/types'

/** Campaigns screen data (Task 13). */

export function useCampaignTable() {
  const swr = useSWR<CampaignTableResponse>('/api/campaigns?with=analytics', fetchJson, {
    refreshInterval: 120_000,
    keepPreviousData: true,
  })
  useRealtimeInvalidate(() => void swr.mutate(), { throttleMs: 10_000 })
  return swr
}

export function useCampaignAnalytics(id: string | null, days: 7 | 30) {
  return useSWR<CampaignAnalyticsResponse>(id ? `/api/campaigns/${id}/analytics?days=${days}` : null, fetchJson, {
    refreshInterval: 120_000,
    keepPreviousData: true,
  })
}

export function useCampaignFlow(id: string | null) {
  const swr = useSWR<CampaignFlowResponse>(id ? `/api/campaigns/${id}/flow` : null, fetchJson, {
    refreshInterval: 60_000,
    keepPreviousData: true,
  })
  useRealtimeInvalidate(() => void swr.mutate(), { tables: ['events', 'pending_actions'], throttleMs: 3_000 })
  return swr
}

export function useCampaignInbox(id: string | null) {
  return useSWR<CampaignInboxResponse>(id ? `/api/campaigns/${id}/inbox` : null, fetchJson, {
    refreshInterval: 60_000,
    keepPreviousData: true,
  })
}

export type RequestedAction = { id: string; kind: string; summary: string }

/**
 * `POST /api/actions` for a campaign kind. Only creates the pending action
 * (+ Telegram prompt); nothing is sent until it is confirmed.
 */
export async function requestCampaignAction(
  kind: CampaignActionKind,
  payload: Record<string, unknown>
): Promise<{ ok: true; action: RequestedAction } | { ok: false; error: string; existingId?: string | null }> {
  let res: Response
  try {
    res = await fetch('/api/actions', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ kind, payload }),
    })
  } catch {
    return { ok: false, error: 'network' }
  }
  const body = (await res.json().catch(() => ({}))) as { action?: RequestedAction; error?: string; existing_id?: string | null }
  if (res.ok && body.action) return { ok: true, action: body.action }
  return { ok: false, error: body.error ?? `HTTP ${res.status}`, existingId: body.existing_id }
}
