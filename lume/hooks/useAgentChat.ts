'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApprovalDecision, ChatApproval } from '@/components/agent/ApprovalCard'
import type { ToolLogEntry } from '@/components/orb/ToolLog'
import { parseSseFrames, type AgentEvent } from '@/lib/agent/chat'
import type { StoredMessage } from '@/lib/agent/history'
import type { SkillMode } from '@/lib/agent/skillModel'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  tools: ToolLogEntry[]
  approvals: ChatApproval[]
  error?: string
  /** 503 agent_not_configured: rendered as a notice, not an error. */
  notConfigured?: boolean
  streaming?: boolean
  /** Live status from the run (e.g. a server-side web search); cleared when text or a tool arrives. */
  status?: string
  /** A saved skill sent with this message (shown on the bubble; not stored). */
  skill?: { name: string; mode: SkillMode }
  /** An automatic follow-up turn (an approval outcome): a muted line, not a bubble. */
  auto?: boolean
}

export interface SendOptions {
  /** Sent by Lume itself (an approval outcome), not typed by the owner. */
  auto?: boolean
}

/** A saved skill to send with the next message: run it, or attach it as reference. */
export interface SkillRef {
  id: string
  name: string
  mode: SkillMode
}

export interface AgentChat {
  messages: ChatMessage[]
  busy: boolean
  /** A stored conversation is being fetched. */
  loading: boolean
  /** The conversation in the URL is missing or deleted. */
  notFound: boolean
  /** The conversation being shown (null = a new, unsaved chat). */
  conversationId: string | null
  /** A tool is executing in the live run. */
  acting: boolean
  /** Name of the client tool running in the live run, if any. */
  runningTool: string | null
  /** Live status line from the run (server-side web tools). */
  liveStatus: string | null
  /** Assistant text is arriving for the live run. */
  streaming: boolean
  send: (text: string, skill?: SkillRef, opts?: SendOptions) => Promise<void>
  /** Tell the agent how an in-chat approval came out: sent now, or after the live run settles. */
  followUp: (d: ApprovalDecision) => void
  reset: () => void
}

export interface AgentChatOptions {
  /** The conversation to show; null starts a new chat. */
  conversationId?: string | null
  /** The server created (or confirmed) the conversation for this run. */
  onConversation?: (id: string) => void
  /** A run finished (stored on the server): refresh anything that lists conversations. */
  onSettled?: () => void
}

let seq = 0
const nextId = () => `m${Date.now().toString(36)}${(seq++).toString(36)}`

/** Fold one SSE event from `/api/agent/run` into the assistant message. */
export function applyAgentEvent(m: ChatMessage, e: AgentEvent): ChatMessage {
  switch (e.type) {
    case 'text':
      return { ...m, status: undefined, text: m.text + String(e.delta ?? '') }
    case 'status':
      return { ...m, status: String(e.label ?? '') || undefined }
    case 'tool_start':
      return {
        ...m,
        status: undefined,
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
            ...(e.state ? { state: e.state as ChatApproval['state'] } : {}),
          },
        ],
      }
    case 'error':
      return { ...m, error: String(e.message ?? 'The run failed.') }
    default:
      return m
  }
}

/** The automatic turn that tells the agent what the owner decided in an approval card. */
export function approvalFollowUp(d: ApprovalDecision): string {
  return d.decision === 'approve'
    ? `[approval] I approved ${d.tool} (${d.summary ?? ''}). Outcome: ${d.status}${d.error ? ` — ${d.error}` : ''}. Continue.`
    : `[approval] I denied ${d.tool} (${d.summary ?? ''}). Don't retry it; tell me what you'd do instead.`
}

/** A stored message, as the chat renders it. */
export function storedToChat(m: StoredMessage): ChatMessage {
  return {
    id: m.id,
    role: m.role,
    text: m.text ?? '',
    tools: (m.tools ?? []) as ToolLogEntry[],
    approvals: (m.approvals ?? []) as ChatApproval[],
    ...(m.error ? { error: m.error } : {}),
    ...(m.auto ? { auto: true } : {}),
  }
}

/**
 * Chat over `/api/agent/run` (SSE: run, text, tool_start,
 * tool_end, approval, done, error). Each send is its own server run; the
 * server stores both turns and packs earlier ones into the prompt, so the
 * client only sends the new message and the conversation id (adopted from the
 * `run` event on a new chat). The route cannot abort a run, so the composer is
 * simply disabled while one is live.
 */
export function useAgentChat(opts: AgentChatOptions = {}): AgentChat {
  const { conversationId = null } = opts
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const [current, setCurrent] = useState<string | null>(null)
  const busyRef = useRef(false)
  // The conversation on screen; a URL change to it (after `run`) must not reload it.
  const currentRef = useRef<string | null>(null)
  // Approval follow-ups waiting for the live run to settle, one per action.
  const queueRef = useRef(new Map<string, string>())
  const [queued, setQueued] = useState(0)
  const optsRef = useRef(opts)
  useEffect(() => {
    optsRef.current = opts
  })

  useEffect(() => {
    if (conversationId === currentRef.current) return
    currentRef.current = conversationId
    setCurrent(conversationId)
    // A follow-up belongs to the conversation it was decided in.
    queueRef.current.clear()
    setNotFound(false)
    setMessages([])
    if (!conversationId) {
      setLoading(false)
      return
    }
    const ctl = new AbortController()
    setLoading(true)
    fetch(`/api/agent/conversations/${conversationId}`, { credentials: 'same-origin', signal: ctl.signal })
      .then(async (res) => {
        if (res.status === 404 || res.status === 400) return setNotFound(true)
        if (!res.ok) throw new Error(`Could not load this conversation (${res.status}).`)
        const body = (await res.json()) as { messages: StoredMessage[] }
        if (currentRef.current === conversationId) setMessages(body.messages.map(storedToChat))
      })
      .catch((err: unknown) => {
        if (ctl.signal.aborted) return
        setMessages([{ id: nextId(), role: 'assistant', text: '', tools: [], approvals: [], error: err instanceof Error ? err.message : 'Could not load this conversation.' }])
      })
      .finally(() => {
        if (!ctl.signal.aborted) setLoading(false)
      })
    return () => ctl.abort()
  }, [conversationId])

  const patch = useCallback((id: string, fn: (m: ChatMessage) => ChatMessage) => {
    setMessages((ms) => ms.map((m) => (m.id === id ? fn(m) : m)))
  }, [])

  const send = useCallback(
    async (raw: string, skill?: SkillRef, sendOpts: SendOptions = {}) => {
      const text = raw.trim()
      if (!text || busyRef.current) return
      busyRef.current = true
      setBusy(true)
      const userMsg: ChatMessage = {
        id: nextId(),
        role: 'user',
        text,
        tools: [],
        approvals: [],
        ...(skill ? { skill: { name: skill.name, mode: skill.mode } } : {}),
        ...(sendOpts.auto ? { auto: true } : {}),
      }
      const aid = nextId()
      setMessages((ms) => [...ms, userMsg, { id: aid, role: 'assistant', text: '', tools: [], approvals: [], streaming: true }])
      try {
        const res = await fetch('/api/agent/run', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: text,
            ...(currentRef.current ? { conversation_id: currentRef.current } : {}),
            ...(skill ? { skill_id: skill.id, skill_mode: skill.mode } : {}),
            ...(sendOpts.auto ? { auto: true } : {}),
          }),
        })
        if (!res.ok || !res.body) {
          const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string }
          if (res.status === 503 || body.error === 'agent_not_configured') {
            patch(aid, (m) => ({ ...m, notConfigured: true, error: body.message ?? 'The agent is not configured yet.' }))
          } else if (body.error === 'skill_not_found') {
            patch(aid, (m) => ({ ...m, error: 'That skill was deleted. Pick another one.' }))
          } else if (res.status === 404) {
            patch(aid, (m) => ({ ...m, error: 'This conversation was deleted. Start a new chat.' }))
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
          const run = events.find((e) => e.type === 'run' && typeof e.conversation_id === 'string')
          if (run && run.conversation_id !== currentRef.current) {
            currentRef.current = String(run.conversation_id)
            setCurrent(currentRef.current)
            optsRef.current.onConversation?.(currentRef.current)
          }
          if (events.length) patch(aid, (m) => events.reduce(applyAgentEvent, m))
        }
      } catch (err) {
        patch(aid, (m) => ({ ...m, error: err instanceof Error ? err.message : 'Connection lost.' }))
      } finally {
        patch(aid, (m) => ({ ...m, streaming: false }))
        busyRef.current = false
        setBusy(false)
        optsRef.current.onSettled?.()
      }
    },
    [patch]
  )

  const followUp = useCallback(
    (d: ApprovalDecision) => {
      const text = approvalFollowUp(d)
      if (!busyRef.current) {
        void send(text, undefined, { auto: true })
        return
      }
      queueRef.current.set(d.action_id, text)
      setQueued((n) => n + 1)
    },
    [send]
  )

  // The live run settled: send the next queued follow-up (its own run drains the rest).
  useEffect(() => {
    if (busy) return
    const next = queueRef.current.entries().next()
    if (next.done) return
    queueRef.current.delete(next.value[0])
    void send(next.value[1], undefined, { auto: true })
  }, [busy, queued, send])

  /** Clear the screen for a new chat (the caller also drops `?c=` from the URL). */
  const reset = useCallback(() => {
    if (busyRef.current) return
    queueRef.current.clear()
    currentRef.current = null
    setCurrent(null)
    setNotFound(false)
    setMessages([])
  }, [])

  const live = busy ? messages.at(-1) : undefined
  return {
    messages,
    busy,
    loading,
    notFound,
    conversationId: current,
    acting: !!live?.tools.some((t) => t.status === 'running'),
    runningTool: live?.tools.findLast((t) => t.status === 'running')?.name ?? null,
    liveStatus: live?.status ?? null,
    streaming: !!live?.text,
    send,
    followUp,
    reset,
  }
}
