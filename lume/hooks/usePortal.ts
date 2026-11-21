'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import useSWR from 'swr'
import useSWRInfinite from 'swr/infinite'
import { fetchJson } from '@/hooks/fetcher'
import { sendJson } from '@/lib/validate/client'
import { leadsApiUrl, withAs, type PortalFilters } from '@/components/portal/query'
import type { PortalAgentMessage, PortalAgentResponse, PortalLead, PortalLeadsResponse, PortalMe } from '@/lib/portal/types'

/** The signed-in client (or the previewed one, for the owner with `?as=`). */
export function usePortalMe(as?: string | null) {
  return useSWR<PortalMe>(withAs('/api/portal/me', as), fetchJson, {
    revalidateOnFocus: false,
  })
}

/** One page (50) of leads for the given filters; keeps the previous page on screen while the next loads. */
export function usePortalLeads(filters: PortalFilters, as?: string | null) {
  return useSWR<PortalLeadsResponse>(leadsApiUrl(filters, as), fetchJson, {
    keepPreviousData: true,
  })
}

/**
 * The lead list as an infinite scroll: pages of 50 for the given filters,
 * fetched one after another as `loadMore` is called (the screen calls it when
 * a sentinel near the bottom scrolls into view). New filters mean a new key,
 * so the list starts over from page 1.
 */
export function usePortalLeadsInfinite(filters: PortalFilters, as?: string | null) {
  const getKey = useCallback(
    (index: number, prev: PortalLeadsResponse | null) => {
      if (prev && (prev.rows.length === 0 || prev.page * (prev.pageSize || 50) >= prev.total)) return null
      return leadsApiUrl({ ...filters, page: index + 1 }, as)
    },
    [filters, as]
  )
  const swr = useSWRInfinite<PortalLeadsResponse>(getKey, fetchJson, {
    revalidateFirstPage: false,
    keepPreviousData: true,
  })
  const { data, size, setSize, isLoading, isValidating, error, mutate } = swr
  const rows = useMemo(() => (data ?? []).flatMap((p) => p.rows), [data])
  const first = data?.[0]
  const last = data?.[data.length - 1]
  const total = first?.total ?? 0
  const reachedEnd = Boolean(last && (last.rows.length === 0 || rows.length >= total))
  const loadingMore = Boolean(!error && size > 0 && (!data || data.length < size))
  const loadMore = useCallback(() => {
    if (!reachedEnd && !loadingMore && !error) void setSize((n) => n + 1)
  }, [reachedEnd, loadingMore, error, setSize])
  return {
    data: first ? { ...first, rows } : undefined,
    rows,
    total,
    reachedEnd,
    loadingMore,
    loadMore,
    isLoading,
    isValidating,
    error,
    mutate,
  }
}

/** Current time, re-rendering at the top of every minute (local times stay right). */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined
    const first = setTimeout(
      () => {
        setNow(new Date())
        interval = setInterval(() => setNow(new Date()), 60_000)
      },
      60_000 - (Date.now() % 60_000)
    )
    return () => {
      clearTimeout(first)
      if (interval) clearInterval(interval)
    }
  }, [])
  return now
}

export interface PortalChatMessage extends PortalAgentMessage {
  leads?: PortalLead[]
}

/** The assistant chat: sends the running message list to `/api/portal/agent` (non-streaming). */
export function usePortalAgent(as?: string | null) {
  const [messages, setMessages] = useState<PortalChatMessage[]>([])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busy = useRef(false)

  const post = useCallback(
    async (history: PortalChatMessage[]) => {
      busy.current = true
      setPending(true)
      setError(null)
      const body = {
        messages: history.map(({ role, content }) => ({ role, content })),
      }
      const r = await sendJson<PortalAgentResponse & { error?: string }>(withAs('/api/portal/agent', as), body, { timeoutMs: 90_000 })
      if (r.status === 200 && r.body && typeof r.body.reply === 'string') {
        const reply = r.body
        setMessages([...history, { role: 'assistant', content: reply.reply, leads: reply.leads ?? [] }])
      } else {
        setError(
          r.status === 0
            ? r.aborted
              ? 'The assistant took too long. Try again.'
              : 'Could not reach the server. Check your connection.'
            : (r.body?.error ?? 'The assistant could not answer. Try again.')
        )
      }
      busy.current = false
      setPending(false)
    },
    [as]
  )

  const send = useCallback(
    (text: string) => {
      const content = text.trim()
      if (!content || busy.current) return false
      const next: PortalChatMessage[] = [...messages, { role: 'user', content }]
      setMessages(next)
      void post(next)
      return true
    },
    [messages, post]
  )

  /** Re-sends the conversation after an error (the last message is the unanswered question). */
  const retry = useCallback(() => {
    if (busy.current || messages.length === 0) return
    void post(messages)
  }, [messages, post])

  return { messages, pending, error, send, retry }
}
