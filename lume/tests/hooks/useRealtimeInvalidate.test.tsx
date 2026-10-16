// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'

type Handler = (payload: { new?: Record<string, unknown> }) => void
const handlers: { table: string; event: string; fn: Handler }[] = []
const channel = {
  on: (_t: string, f: { event: string; table: string }, fn: Handler) => {
    handlers.push({ table: f.table, event: f.event, fn })
    return channel
  },
  subscribe: () => channel,
}
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ channel: () => channel, removeChannel: async () => {} }),
}))

import { useRealtimeInvalidate } from '@/hooks/useRealtimeInvalidate'
import { overviewRelevant } from '@/hooks/useOverview'

const insert = (table: string, record: Record<string, unknown>) =>
  handlers.filter((h) => h.table === table && h.event === 'INSERT').forEach((h) => h.fn({ new: record }))

beforeEach(() => {
  handlers.length = 0
  vi.useFakeTimers()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('overviewRelevant', () => {
  it('passes the event types the Overview shows, and all pending_actions', () => {
    const ev = (type: string) => overviewRelevant({ table: 'events', eventType: 'INSERT', record: { type } })
    expect(['reply', 'interested', 'bounce', 'agent.tool', 'lume.gate_ping'].every(ev)).toBe(true)
    expect(['rotation_runs.inserted', 'sent', 'instantly.lead_unsubscribed', ''].some(ev)).toBe(false)
    expect(overviewRelevant({ table: 'pending_actions', eventType: 'UPDATE', record: {} })).toBe(true)
  })
})

describe('useRealtimeInvalidate', () => {
  it('drops filtered changes and throttles to one call per window', () => {
    const cb = vi.fn()
    renderHook(() => useRealtimeInvalidate(cb, { tables: ['events'], filter: overviewRelevant, throttleMs: 5000 }))

    insert('events', { type: 'rotation_runs.inserted' })
    vi.advanceTimersByTime(1000)
    expect(cb).not.toHaveBeenCalled()

    insert('events', { type: 'reply' })
    vi.advanceTimersByTime(300)
    expect(cb).toHaveBeenCalledTimes(1) // leading call after the debounce

    for (let i = 0; i < 20; i++) insert('events', { type: 'reply' })
    vi.advanceTimersByTime(3000)
    expect(cb).toHaveBeenCalledTimes(1) // still inside the 5 s window
    vi.advanceTimersByTime(2000)
    expect(cb).toHaveBeenCalledTimes(2) // one trailing call for the burst
    vi.advanceTimersByTime(10_000)
    expect(cb).toHaveBeenCalledTimes(2)
  })

  it('without throttle it debounces as before', () => {
    const cb = vi.fn()
    renderHook(() => useRealtimeInvalidate(cb, { tables: ['events'] }))
    insert('events', { type: 'x' })
    vi.advanceTimersByTime(200)
    insert('events', { type: 'x' })
    vi.advanceTimersByTime(299)
    expect(cb).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(cb).toHaveBeenCalledTimes(1)
  })
})
