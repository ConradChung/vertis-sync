'use client'

import useSWR from 'swr'
import { fetchJson } from '@/hooks/fetcher'
import type { TagVertical } from '@/lib/tags/model'

export const TAGS_KEY = '/api/tags'

/** The live verticals, as tags (id + name), A→Z; `enabled` false skips the request. */
export function useTags(enabled = true) {
  const r = useSWR<{ tags: TagVertical[] }>(enabled ? TAGS_KEY : null, fetchJson, { revalidateOnFocus: false, dedupingInterval: 60_000 })
  return { tags: r.data?.tags ?? [], error: r.error, isLoading: r.isLoading }
}
