'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { PendingApproval } from '@/components/orb/PlanCard'
import type { ToolLogEntry } from '@/components/orb/ToolLog'
import { buildPrompt, parseSseFrames, type AgentEvent } from '@/lib/agent/chat'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  tools: ToolLogEntry[]
  approvals: PendingApproval[]
  error?: string
  /** 503 agent_not_configured: rendered as a notice, not an error. */
  notConfigured?: boolean
  streaming?: boolean
}

export interface AgentChat {
  messages: ChatMessage[]
  busy: boolean
  /** A tool is executing in the live run. */
  acting: boolean
  /** Assistant text is arriving for the live run. */
  streaming: boolean
  send: (text: string) => Promise<void>
  reset: () => void
}

let seq = 0
const nextId = () => `m${Date.now().toString(36)}${(seq++).toString(36)}`

/** Fold one SSE event from `/api/agent/run` into the assistant message. */
export function applyAgentEvent(m: ChatMessage, e: AgentEvent): ChatMessage {
  switch (e.type) {
    case 'text':
      return { ...m, text: m.text + String(e.delta ?? '') }
    case 'tool_start':
      return {
        ...m,
        tools: [...m.tools, { id: String(e.id), name: String(e.name), tier: e.tier as ToolLogEntry['tier'], status: 'running' }],
      }
    case 'tool_end':
      return {
        ...m,
        tools: m.tools.map((x) =>
          x.id === e.id
            ? { ...x, status: e.ok ? (x.tier === 'high' ? 'awaiting' : 'ok') : 'error', ms: Number(e.ms), error: e.error as string | undefined }
            : x
        ),
      }
    case 'approval':
      return {
        ...m,
        approvals: [
          ...m.approvals.filter((x) => x.action_id !== e.action_id),
          {
            action_id: String(e.action_id),
            deep_link: String(e.deep_link ?? `/actions/${e.action_id}`),
            summary: (e.summary as string | null) ?? null,
            tool: String(e.tool ?? ''),
          },
        ],
      }
    case 'error':
      return { ...m, error: String(e.message ?? 'The run failed.') }
    default:
      return m
  }
}

/**
 * Session-only chat over `/api/agent/run` (SSE: run, text, tool_start,
 * tool_end, approval, done, error). Each send is its own server run; prior
 * turns are packed into the prompt as context (see `buildPrompt`). The route
 * cannot abort a run, so the composer is simply disabled while one is live.
 */
export function useAgentChat(): AgentChat {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const messagesRef = useRef<ChatMessage[]>([])
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  const patch = useCallback((id: string, fn: (m: ChatMessage) => ChatMessage) => {
    setMessages((ms) => ms.map((m) => (m.id === id ? fn(m) : m)))
  }, [])

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim()
      if (!text || busyRef.current) return
      busyRef.current = true
      setBusy(true)
      const history = messagesRef.current
        .filter((m) => !m.notConfigured && (m.role === 'user' || m.text))
        .map((m) => ({ role: m.role, text: m.text }))
      const userMsg: ChatMessage = { id: nextId(), role: 'user', text, tools: [], approvals: [] }
      const aid = nextId()
      setMessages((ms) => [...ms, userMsg, { id: aid, role: 'assistant', text: '', tools: [], approvals: [], streaming: true }])
      try {
        const res = await fetch('/api/agent/run', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: buildPrompt(history, text) }),
        })
        if (!res.ok || !res.body) {
          const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string }
          if (res.status === 503 || body.error === 'agent_not_configured') {
            patch(aid, (m) => ({ ...m, notConfigured: true, error: body.message ?? 'The agent is not configured yet.' }))
          } else {
            patch(aid, (m) => ({ ...m, error: `Request failed (${res.status}${body.error ? `: ${body.error}` : ''})` }))
          }
          return
        }
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
        let buffer = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          const { events, rest } = parseSseFrames(buffer + value)
          buffer = rest
          if (events.length) patch(aid, (m) => events.reduce(applyAgentEvent, m))
        }
      } catch (err) {
        patch(aid, (m) => ({ ...m, error: err instanceof Error ? err.message : 'Connection lost.' }))
      } finally {
        patch(aid, (m) => ({ ...m, streaming: false }))
        busyRef.current = false
        setBusy(false)
      }
    },
    [patch]
  )

  const reset = useCallback(() => {
    if (!busyRef.current) setMessages([])
  }, [])

  const live = busy ? messages.at(-1) : undefined
  return {
    messages,
    busy,
    acting: !!live?.tools.some((t) => t.status === 'running'),
    streaming: !!live?.text,
    send,
    reset,
  }
}
