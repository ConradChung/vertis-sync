'use client'

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { ArrowUp, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { useNow, usePortalAgent } from '@/hooks/usePortal'
import { LeadCard } from './LeadCard'

/**
 * "Ask the assistant": a plain chat over the client's leads. Read-only — the
 * assistant can only look leads up; found leads render as the same
 * tap-to-call cards as the list.
 */
export function AgentPanel({ as, className }: { as?: string | null; className?: string }) {
  const { messages, pending, error, send, retry } = usePortalAgent(as)
  const now = useNow()
  const [draft, setDraft] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = listRef.current
    if (el && typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [messages.length, pending, error])

  function submit(e?: FormEvent) {
    e?.preventDefault()
    if (pending) return
    if (send(draft)) setDraft('')
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div ref={listRef} className="thin-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4" aria-live="polite">
        {messages.length === 0 && !pending && (
          <div className="flex flex-col gap-2 pt-2 text-[13px] text-fg-46">
            <p className="text-fg-70">Ask for leads in plain words.</p>
            <p>“Who in Dallas has a direct mobile?”</p>
            <p>“Show everyone at Greystar who opened an email.”</p>
          </div>
        )}
        {messages.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className="ml-8 self-end rounded-2xl rounded-br-md bg-secondary px-3.5 py-2 text-[14px] whitespace-pre-wrap text-fg">
              {m.content}
            </div>
          ) : (
            <div key={i} className="flex min-w-0 flex-col gap-3">
              <p className="text-[14px] leading-relaxed whitespace-pre-wrap text-fg-70">{m.content}</p>
              {m.leads && m.leads.length > 0 && (
                <div className="flex flex-col gap-2.5">
                  {m.leads.map((l) => (
                    <LeadCard key={`${l.kind}:${l.id}`} lead={l} now={now} />
                  ))}
                </div>
              )}
            </div>
          )
        )}
        {pending && (
          <div className="flex items-center gap-2 text-[13px] text-fg-46" role="status">
            <Spinner className="size-3.5" /> Looking through your leads…
          </div>
        )}
        {error && (
          <div className="flex items-center justify-between gap-3 rounded-xl bg-destructive/10 px-3 py-2 text-[13px] text-destructive" role="alert">
            <span>{error}</span>
            <Button variant="ghost" size="sm" onClick={retry} className="h-9 shrink-0 text-destructive">
              <RotateCw /> Retry
            </Button>
          </div>
        )}
      </div>
      <form onSubmit={submit} className="flex items-end gap-2 border-t border-(--line) p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <label htmlFor="portal-agent-input" className="sr-only">
          Message the assistant
        </label>
        <textarea
          id="portal-agent-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder="Find the property manager at Greystar in Dallas"
          className="field-sizing-content max-h-36 min-h-11 flex-1 resize-none rounded-xl border border-input bg-transparent px-3 py-2.5 text-[14px] text-fg outline-none placeholder:text-fg-24 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 dark:bg-input/30"
        />
        <Button type="submit" aria-label="Send" disabled={pending || !draft.trim()} className="size-11 shrink-0 rounded-xl">
          {pending ? <Spinner className="size-4" /> : <ArrowUp className="size-5" />}
        </Button>
      </form>
    </div>
  )
}
