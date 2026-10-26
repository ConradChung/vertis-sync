'use client'

import useSWR from 'swr'
import { fetchJson } from '@/hooks/fetcher'
import type { EditStep } from '@/lib/campaigns/sequence'

export type SequenceEditResponse =
  | { configured: false }
  | {
      configured: true
      campaign_id: string
      name: string | null
      hash: string
      steps: EditStep[]
      pending: { id: string; summary: string | null; created_at: string } | null
    }

/** The campaign's full sequence for the editor, read fresh from Instantly (no polling: an open editor must not reset). */
export function useSequenceEdit(campaignId: string | null) {
  return useSWR<SequenceEditResponse>(campaignId ? `/api/campaigns/${encodeURIComponent(campaignId)}/sequence/edit` : null, fetchJson, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
  })
}

export type SequenceSaveResult =
  | { ok: true; id: string; summary: string }
  | { ok: false; error: string; existingId?: string | null; problems?: string[] }

/** `POST /api/actions` kind `update_sequence`: files the edit for approval; nothing is written to Instantly here. */
export async function requestSequenceUpdate(campaignId: string, steps: EditStep[], baseHash: string): Promise<SequenceSaveResult> {
  let res: Response
  try {
    res = await fetch('/api/actions', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ kind: 'update_sequence', payload: { campaign_id: campaignId, steps, base_hash: baseHash } }),
    })
  } catch {
    return { ok: false, error: 'network' }
  }
  const body = (await res.json().catch(() => ({}))) as {
    action?: { id: string; summary: string }
    error?: string
    existing_id?: string | null
    problems?: string[]
  }
  if (res.ok && body.action) return { ok: true, id: body.action.id, summary: body.action.summary }
  return { ok: false, error: body.error ?? `HTTP ${res.status}`, existingId: body.existing_id, problems: body.problems }
}
