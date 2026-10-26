'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowUp, ChevronRight, KeyRound, RotateCcw, Wrench } from 'lucide-react'
import { Markdown } from '@/components/agent/Markdown'
import { Waveform, type WaveMode } from '@/components/agent/Waveform'
import { PlanCard } from '@/components/orb/PlanCard'
import { ToolLog, type ToolLogEntry } from '@/components/orb/ToolLog'
import { useSpeechRecognition, VoiceInput } from '@/components/orb/VoiceInput'
import { useAgentChat, type ChatMessage } from '@/hooks/useAgentChat'
import { cn } from '@/lib/utils'

export const SUGGESTIONS = [
  "What's waiting on me?",
  'Summarize campaign performance this week',
  'Which rules run today?',
  'Any orders stuck in validation?',
] as const

/** Typing somewhere else: `/` and ⌘K belong to that field. */
function isTypingTarget(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable || el.getAttribute('role') === 'textbox'
}

function greeting(d = new Date()) {
  const h = d.getHours()
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

/**
 * `/agent`: a ChatGPT/Claude-style conversation with the Lume agent. Centered
 * 760px column, messages above, composer pinned at the bottom with a voice
 * waveform (idle pulse / live mic / working shimmer).
 */
export function AgentChat() {
  const chat = useAgentChat()
  const speech = useSpeechRecognition()
  const [draft, setDraft] = useState('')
  const [hello, setHello] = useState('Hello')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const { messages, busy, send } = chat

  useEffect(() => setHello(greeting()), [])

  const submit = useCallback(
    (text: string) => {
      if (!text.trim() || busy) return
      setDraft('')
      void send(text)
    },
    [busy, send]
  )

  // Hand the composer back once a run finishes (it is disabled while one is live).
  const hadRun = messages.length > 0
  useEffect(() => {
    if (!busy && hadRun) inputRef.current?.focus()
  }, [busy, hadRun])

  // Auto-grow the textarea up to ~8 lines.
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [draft])

  // Keep the newest message in view while it streams.
  const last = messages.at(-1)
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [messages.length, last?.text, last?.tools.length, last?.approvals.length])

  // `/` or ⌘K / Ctrl+K focuses the composer when nothing else is being typed in.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const slash = e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey
      const cmdK = e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)
      if (!slash && !cmdK) return
      if (isTypingTarget(document.activeElement)) return
      e.preventDefault()
      inputRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const mode: WaveMode = speech.listening ? 'listening' : busy ? 'thinking' : 'idle'
  const status = speech.listening
    ? speech.transcript || 'Listening…'
    : busy
      ? chat.acting
        ? 'Running a tool…'
        : chat.streaming
          ? 'Writing…'
          : 'Thinking…'
      : null

  return (
    <div className="mx-auto flex min-h-[calc(100dvh-var(--topbar-h)-110px)] w-full max-w-[760px] flex-col">
      <div className="flex-1" aria-live="polite" aria-busy={busy}>
        {messages.length === 0 ? (
          <EmptyState hello={hello} onPick={submit} disabled={busy} />
        ) : (
          <ol className="flex flex-col gap-7 pt-2 pb-6" aria-label="Conversation">
            {messages.map((m) => (
              <li key={m.id}>
                <Message m={m} />
              </li>
            ))}
          </ol>
        )}
        <div ref={endRef} />
      </div>

      <div className="sticky bottom-0 z-10 -mx-2 px-2 pt-10 pb-3 backdrop-blur-xl mask-[linear-gradient(to_top,black_78%,transparent)]">
        <div className="mb-2 flex items-center justify-center gap-3">
          <Waveform mode={mode} className="h-11" />
        </div>
        {status && (
          <p className="mb-2 truncate text-center text-[12px] text-fg-46" role="status">
            {status}
          </p>
        )}
        <form
          className={cn(
            'glass flex items-end gap-2 rounded-[22px] border border-line p-2 pl-4 transition-colors focus-within:border-violet/50',
            speech.listening && 'border-violet/60'
          )}
          onSubmit={(e) => {
            e.preventDefault()
            submit(draft)
          }}
        >
          <label htmlFor="agent-composer" className="sr-only">
            Message Lume
          </label>
          <textarea
            id="agent-composer"
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submit(draft)
              }
            }}
            rows={1}
            maxLength={4000}
            disabled={busy}
            placeholder={busy ? 'Lume is working…' : 'Ask Lume anything — press / to focus'}
            aria-describedby="agent-composer-hint"
            className="max-h-[220px] min-h-10 flex-1 resize-none bg-transparent py-2 text-[15px] leading-6 text-fg outline-none placeholder:text-fg-24 disabled:opacity-60"
          />
          <VoiceInput speech={speech} onFinal={submit} />
          <button
            type="submit"
            disabled={busy || !draft.trim()}
            aria-label="Send message"
            className="grid size-9 shrink-0 place-items-center rounded-full bg-violet text-white transition-opacity disabled:opacity-35"
          >
            <ArrowUp className="size-4" />
          </button>
        </form>
        <p id="agent-composer-hint" className="mt-2 flex items-center justify-center gap-3 text-[11px] text-fg-24">
          <span>Enter to send · Shift+Enter for a new line</span>
          <span aria-hidden>·</span>
          <span>Anything risky waits for your approval</span>
          {messages.length > 0 && !busy && (
            <button type="button" onClick={chat.reset} className="inline-flex items-center gap-1 text-fg-46 hover:text-fg">
              <RotateCcw className="size-3" /> New chat
            </button>
          )}
        </p>
        {speech.error && (
          <p className="mt-1 text-center text-[12px] text-red" role="alert">
            Microphone: {speech.error}
          </p>
        )}
      </div>
    </div>
  )
}

function EmptyState({ hello, onPick, disabled }: { hello: string; onPick: (t: string) => void; disabled: boolean }) {
  return (
    <div className="flex min-h-[46vh] flex-col items-center justify-center text-center">
      <h2 className="text-[30px] font-semibold tracking-[-0.8px] text-fg">{hello}.</h2>
      <p className="mt-2 text-[15px] text-fg-46">Ask about orders, gates, campaigns or rules — or tell me what to run.</p>
      <div className="mt-7 flex max-w-[620px] flex-wrap justify-center gap-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            disabled={disabled}
            onClick={() => onPick(s)}
            className="rounded-full border border-line bg-white/4 px-3.5 py-2 text-[13px] text-fg-70 transition-colors hover:border-violet/40 hover:bg-white/8 hover:text-fg disabled:opacity-50"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  )
}

function Message({ m }: { m: ChatMessage }) {
  if (m.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-[20px] bg-white/8 px-4 py-2.5 text-[15px] leading-6 whitespace-pre-wrap text-fg">{m.text}</div>
      </div>
    )
  }
  const waiting = m.streaming && !m.text && !m.tools.length && !m.error
  return (
    <div className="flex flex-col gap-3">
      {m.tools.length > 0 && <ToolChips tools={m.tools} live={!!m.streaming} />}
      {waiting && <ThinkingDots />}
      {m.text && <Markdown text={m.text} />}
      <PlanCard approvals={m.approvals} />
      {m.notConfigured ? (
        <div className="flex items-start gap-3 rounded-panel border border-amber/40 bg-amber/8 px-4 py-3 text-[13px]" role="status">
          <KeyRound className="mt-0.5 size-4 shrink-0 text-amber" />
          <div>
            <p className="font-medium text-amber">The agent isn&apos;t set up yet</p>
            <p className="mt-0.5 text-fg-70">
              {m.error} Add <code className="font-mono text-[12px] text-fg">ANTHROPIC_API_KEY</code> to the deployment&apos;s environment and redeploy — the rest
              of Lume works without it.
            </p>
          </div>
        </div>
      ) : (
        m.error && (
          <p className="rounded-control border border-red/40 bg-red/10 px-3 py-2 text-[13px] text-red" role="alert">
            {m.error}
          </p>
        )
      )}
    </div>
  )
}

function ToolChips({ tools, live }: { tools: ToolLogEntry[]; live: boolean }) {
  const running = tools.some((t) => t.status === 'running')
  const failed = tools.filter((t) => t.status === 'error').length
  const ms = tools.reduce((s, t) => s + (t.ms ?? 0), 0)
  return (
    <details className="group w-fit max-w-full" open={live && running ? true : undefined}>
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-full border border-line bg-white/4 px-3 py-1 text-[12px] text-fg-46 select-none hover:text-fg [&::-webkit-details-marker]:hidden">
        <Wrench className={cn('size-3', running && 'animate-pulse text-violet-soft')} />
        {running ? `Using ${tools.at(-1)?.name}` : `Used ${tools.length} tool${tools.length === 1 ? '' : 's'}`}
        {failed > 0 && <span className="text-red">· {failed} failed</span>}
        {!running && ms > 0 && <span className="text-fg-24">· {(ms / 1000).toFixed(1)}s</span>}
        <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
      </summary>
      <div className="mt-2">
        <ToolLog entries={tools} />
      </div>
    </details>
  )
}

function ThinkingDots() {
  return (
    <div className="flex h-6 items-center gap-1" aria-label="Thinking">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1.5 animate-pulse rounded-full bg-fg-46 motion-reduce:animate-none"
          style={{ animationDelay: `${i * 160}ms` }}
        />
      ))}
    </div>
  )
}

