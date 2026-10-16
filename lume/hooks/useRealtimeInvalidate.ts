'use client'

import { useEffect, useId, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'

export type RealtimeTable = 'events' | 'pending_actions' | 'agent_runs'

/** What a filter sees for each change. `record` is the new row (INSERT/UPDATE). */
export interface RealtimeChange {
  table: RealtimeTable
  eventType: 'INSERT' | 'UPDATE'
  record: Record<string, unknown>
}

export interface RealtimeInvalidateOptions {
  /** Ignore changes this returns false for (e.g. event types the screen doesn't show). */
  filter?: (change: RealtimeChange) => boolean
  /**
   * At most one callback per this many ms (leading edge after the debounce,
   * then one trailing call for anything that arrived in between). Off by default.
   */
  throttleMs?: number
  /** Defaults to `['events']`. */
  tables?: RealtimeTable[]
  /** Debounce window; bursts of inserts collapse into one callback. */
  debounceMs?: number
  /** Set false to pause the subscription (e.g. a screen that is not visible). */
  enabled?: boolean
}

/**
 * Subscribes the browser client to Postgres changes and calls `onChange`
 * (debounced, 300 ms by default; optionally filtered and throttled) so a screen's SWR cache can be revalidated
 * without polling. RLS (`lume_is_owner()`) scopes what the socket sees.
 *
 * `events` is INSERT-only: the daily purge emits DELETEs that mean nothing
 * to the UI. `pending_actions` and `agent_runs` get INSERT + UPDATE (status
 * transitions matter there). Unsubscribes on unmount; the callback is kept in
 * a ref so a new closure per render does not resubscribe.
 */
export function useRealtimeInvalidate(onChange: () => void, options: RealtimeInvalidateOptions = {}): void {
  const { debounceMs = 300, enabled = true, throttleMs = 0 } = options
  const tables = options.tables ?? ['events']
  const tablesKey = tables.join(',')

  // realtime-js dedupes channels by topic: two hooks on the same page that
  // both asked for `events` would otherwise share (and, on unmount, tear down)
  // one channel. useId gives each mounted hook its own stable topic.
  const topicId = useId()

  const callbackRef = useRef(onChange)
  callbackRef.current = onChange
  const filterRef = useRef(options.filter)
  filterRef.current = options.filter

  useEffect(() => {
    if (!enabled) return
    const supabase = createClient()
    let timer: ReturnType<typeof setTimeout> | null = null
    let disposed = false
    let lastFiredAt = -Infinity

    const run = () => {
      timer = null
      if (disposed) return
      lastFiredAt = Date.now()
      callbackRef.current()
    }

    const schedule = () => {
      if (!throttleMs) {
        if (timer) clearTimeout(timer)
        timer = setTimeout(run, debounceMs)
        return
      }
      // Throttled: a pending call already covers this change.
      if (timer) return
      const wait = Math.max(debounceMs, lastFiredAt + throttleMs - Date.now())
      timer = setTimeout(run, wait)
    }

    const handler = (table: RealtimeTable, eventType: 'INSERT' | 'UPDATE') => (payload: { new?: unknown }) => {
      const record = (payload?.new ?? {}) as Record<string, unknown>
      const filter = filterRef.current
      if (filter && !filter({ table, eventType, record })) return
      schedule()
    }

    const channel = supabase.channel(`lume-invalidate:${tablesKey}:${topicId}`)
    for (const table of tablesKey.split(',') as RealtimeTable[]) {
      channel.on('postgres_changes', { event: 'INSERT', schema: 'public', table }, handler(table, 'INSERT'))
      if (table !== 'events') {
        channel.on('postgres_changes', { event: 'UPDATE', schema: 'public', table }, handler(table, 'UPDATE'))
      }
    }
    channel.subscribe()

    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
      void supabase.removeChannel(channel)
    }
  }, [tablesKey, debounceMs, throttleMs, enabled, topicId])
}
