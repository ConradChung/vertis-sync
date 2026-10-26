'use client'

import dynamic from 'next/dynamic'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowUp, X } from 'lucide-react'
import { PlanCard, type PendingApproval } from '@/components/orb/PlanCard'
import { ToolLog, type ToolLogEntry } from '@/components/orb/ToolLog'
import { VoiceInput, type Speech } from '@/components/orb/VoiceInput'
import type { OrbState } from '@/components/orb/Orb'

const Orb = dynamic(() => import('@/components/orb/Orb'), {
  ssr: false,
  loading: () => <div className="size-[122px]" aria-hidden />,
})

interface Turn {
  role: 'user' | 'agent'
  text: string
}

export interface AgentConversation {
  turns: Turn[]
  tools: ToolLogEntry[]
  approvals: PendingApproval[]
  busy: boolean
  /** A tool is executing in this run right now. */
  acting: boolean
  error: string | null
  send: (prompt: string) => Promise<void>
}

/**
 * Talks to `/api/agent/run` and folds its SSE stream (text, tool_start,
 * tool_end, approval, done, error) into transcript, tool log and approvals.
 * Each prompt is its own run.
 */
export function useAgentConversation(): AgentConversation {
  const [turns, setTurns] = useState<Turn[]>([])
  const [tools, setTools] = useState<ToolLogEntry[]>([])
  const [approvals, setApprovals] = useState<PendingApproval[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const appendAgentText = (delta: string) =>
    setTurns((t) => {
      const last = t.at(-1)
      if (last?.role === 'agent') return [...t.slice(0, -1), { role: 'agent', text: last.text + delta }]
      return [...t, { role: 'agent', text: delta }]
    })

  const handle = useCallback((e: Record<string, unknown>) => {
    switch (e.type) {
      case 'text':
        appendAgentText(String(e.delta ?? ''))
        break
      case 'tool_start':
        setTools((t) => [...t, { id: String(e.id), name: String(e.name), tier: e.tier as ToolLogEntry['tier'], status: 'running' }])
        break
      case 'tool_end':
        setTools((t) =>
          t.map((x) =>
            x.id === e.id
              ? { ...x, status: e.ok ? (x.tier === 'high' ? 'awaiting' : 'ok') : 'error', ms: Number(e.ms), error: e.error as string | undefined }
              : x
          )
        )
        break
      case 'approval':
        setApprovals((a) => [
          ...a.filter((x) => x.action_id !== e.action_id),
          {
            action_id: String(e.action_id),
            deep_link: String(e.deep_link ?? `/actions/${e.action_id}`),
            summary: (e.summary as string | null) ?? null,
            tool: String(e.tool ?? ''),
          },
        ])
        break
      case 'error':
        setError(String(e.message ?? 'The run failed.'))
        break
    }
  }, [])

  const send = useCallback(
    async (prompt: string) => {
      const text = prompt.trim()
      if (!text || busy) return
      setBusy(true)
      setError(null)
      setTools([])
      setTurns((t) => [...t, { role: 'user', text }])
      try {
        const res = await fetch('/api/agent/run', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: text }),
        })
        if (!res.ok || !res.body) {
          const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string }
          setError(
            res.status === 503 ? (body.message ?? 'The agent is not configured.') : `Request failed (${res.status}${body.error ? `: ${body.error}` : ''})`
          )
          return
        }
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
        let buffer = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += value
          let idx: number
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, idx)
            buffer = buffer.slice(idx + 2)
            const line = frame.split('\n').find((l) => l.startsWith('data: '))
            if (!line) continue
            try {
              handle(JSON.parse(line.slice(6)))
            } catch {
              // malformed frame: skip
            }
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Connection lost.')
      } finally {
        setBusy(false)
      }
    },
    [busy, handle]
  )

  return { turns, tools, approvals, busy, acting: tools.some((t) => t.status === 'running'), error, send }
}

export interface OrbSheetProps {
  open: boolean
  onClose: () => void
  orbState: OrbState
  conversation: AgentConversation
  speech: Speech
}

export function OrbSheet({ open, onClose, orbState, conversation, speech }: OrbSheetProps) {
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const { turns, tools, approvals, busy, error, send } = conversation

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [turns, tools, approvals])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const submit = (text: string) => {
    if (!text.trim() || busy) return
    setDraft('')
    void send(text)
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          role="dialog"
          aria-label="Lume agent"
          initial={{ opacity: 0, y: -12, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -12, scale: 0.98 }}
          transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
          className="glass fixed top-[calc(var(--topbar-h)+8px)] right-4 z-30 flex max-h-[calc(100dvh-var(--topbar-h)-24px)] w-[min(440px,calc(100vw-32px))] flex-col overflow-hidden rounded-panel-lg"
        >
          <header className="flex items-center gap-3 border-b border-line px-4 py-3">
            <div className="-my-8 -ml-6 scale-[0.6]">
              <Orb state={orbState} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-medium text-fg">Lume</p>
              <p className="text-[11px] text-fg-46">{stateLabel(orbState)}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="grid size-8 place-items-center rounded-full text-fg-46 hover:bg-white/8 hover:text-fg"
            >
              <X className="size-4" />
            </button>
          </header>

          <div ref={scrollRef} className="flex min-h-[160px] flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
            {turns.length === 0 && !speech.listening && (
              <p className="text-[13px] text-fg-46">
                Ask about orders, gates, campaigns or rules, or tell me what to run. Anything risky waits for your approval.
                Hold space to talk.
              </p>
            )}
            {turns.map((t, i) => (
              <div
                key={i}
                className={
                  t.role === 'user'
                    ? 'self-end rounded-panel bg-violet/25 px-3 py-2 text-[13px] text-fg'
                    : 'text-[14px] leading-relaxed whitespace-pre-wrap text-fg-70'
                }
              >
                {t.text}
              </div>
            ))}
            {speech.listening && (
              <div className="self-end rounded-panel border border-violet/50 px-3 py-2 text-[13px] text-fg-70 italic">
                {speech.transcript || 'Listening…'}
              </div>
            )}
            {busy && turns.at(-1)?.role === 'user' && <p className="text-[12px] text-fg-46">Thinking…</p>}
            <ToolLog entries={tools} />
            <PlanCard approvals={approvals} />
            {error && <p className="rounded-control border border-red/40 bg-red/10 px-3 py-2 text-[12px] text-red">{error}</p>}
            {speech.error && <p className="text-[12px] text-red">Microphone: {speech.error}</p>}
          </div>

          <form
            className="flex items-end gap-2 border-t border-line p-3"
            onSubmit={(e) => {
              e.preventDefault()
              submit(draft)
            }}
          >
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  submit(draft)
                }
              }}
              rows={1}
              maxLength={4000}
              placeholder={busy ? 'Working…' : 'Ask Lume'}
              aria-label="Message Lume"
              className="max-h-32 min-h-9 flex-1 resize-none rounded-control border border-line bg-black/20 px-3 py-2 text-[13px] text-fg outline-none placeholder:text-fg-24 focus:border-violet/60"
            />
            <VoiceInput speech={speech} onFinal={submit} />
            <button
              type="submit"
              disabled={busy || !draft.trim()}
              aria-label="Send"
              className="grid size-9 shrink-0 place-items-center rounded-full bg-violet text-white disabled:opacity-40"
            >
              <ArrowUp className="size-4" />
            </button>
          </form>
        </motion.aside>
      )}
    </AnimatePresence>
  )
}

function stateLabel(s: OrbState): string {
  switch (s) {
    case 'listening':
      return 'Listening'
    case 'thinking':
      return 'Thinking'
    case 'acting':
      return 'Running a tool'
    case 'needs-approval':
      return 'Waiting for your approval'
    default:
      return 'Idle'
  }
}
