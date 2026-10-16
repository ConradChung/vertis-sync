'use client'

import { useEffect, useId, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'

export type RealtimeTable = 'events' | 'pending_actions' | 'agent_runs'

export interface RealtimeInvalidateOptions {
  /** Defaults to `['events']`. */
  tables?: RealtimeTable[]
  /** Debounce window; bursts of inserts collapse into one callback. */
  debounceMs?: number
  /** Set false to pause the subscription (e.g. a screen that is not visible). */
  enabled?: boolean
}

/**
 * Subscribes the browser client to Postgres changes and calls `onChange`
 * (debounced, 300 ms by default) so a screen's SWR cache can be revalidated
 * without polling. RLS (`lume_is_owner()`) scopes what the socket sees.
 *
 * `events` is INSERT-only: the daily purge emits DELETEs that mean nothing
 * to the UI. `pending_actions` and `agent_runs` get INSERT + UPDATE (status
 * transitions matter there). Unsubscribes on unmount; the callback is kept in
 * a ref so a new closure per render does not resubscribe.
 */
export function useRealtimeInvalidate(onChange: () => void, options: RealtimeInvalidateOptions = {}): void {
  const { debounceMs = 300, enabled = true } = options
  const tables = options.tables ?? ['events']
  const tablesKey = tables.join(',')

  // realtime-js dedupes channels by topic: two hooks on the same page that
  // both asked for `events` would otherwise share (and, on unmount, tear down)
  // one channel. useId gives each mounted hook its own stable topic.
  const topicId = useId()

  const callbackRef = useRef(onChange)
  callbackRef.current = onChange

  useEffect(() => {
    if (!enabled) return
    const supabase = createClient()
    let timer: ReturnType<typeof setTimeout> | null = null
    let disposed = false

    const fire = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        if (!disposed) callbackRef.current()
      }, debounceMs)
    }

    const channel = supabase.channel(`lume-invalidate:${tablesKey}:${topicId}`)
    for (const table of tablesKey.split(',') as RealtimeTable[]) {
      channel.on('postgres_changes', { event: 'INSERT', schema: 'public', table }, fire)
      if (table !== 'events') {
        channel.on('postgres_changes', { event: 'UPDATE', schema: 'public', table }, fire)
      }
    }
    channel.subscribe()

    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
      void supabase.removeChannel(channel)
    }
  }, [tablesKey, debounceMs, enabled, topicId])
}
