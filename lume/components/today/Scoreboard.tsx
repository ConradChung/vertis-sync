'use client'

import { useEffect, useState } from 'react'
import type { Scoreboard as Board } from '@/lib/scoreboard/count'
import { sendJson } from '@/lib/validate/client'
import { cn } from '@/lib/utils'

const STATS: { key: keyof Board['counts']; label: string }[] = [
  { key: 'conversations', label: 'Conversations' },
  { key: 'pilots_started', label: 'Pilots started' },
  { key: 'pilots_paid', label: 'Pilots paid' },
]

/**
 * This week's scoreboard: three counts from the CRM and the one line the
 * owner types, "top objection". `editable` (the owner's /today) saves the
 * line on blur or Enter; the client portal shows it read-only.
 *
 * It draws no surface of its own: the page's one surface holds it, and
 * spacing sets it apart. The numbers are plain (no accent colour).
 */
export function Scoreboard({ board, editable = false, onSaved, className }: { board: Board; editable?: boolean; onSaved?: (text: string | null) => void; className?: string }) {
  const saved = board.top_objection ?? ''
  const [text, setText] = useState(saved)
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  // A newer value from the server replaces the field unless the owner is mid-edit.
  useEffect(() => {
    setText((cur) => (state === 'idle' || state === 'saved' ? saved : cur))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved])

  async function save() {
    const next = text.trim()
    if (next === saved.trim()) return
    setState('saving')
    const a = await sendJson<{ ok: true; top_objection: string | null }>('/api/scoreboard', { top_objection: next || null }, { method: 'PUT' })
    if (a.status === 200) {
      setState('saved')
      onSaved?.(a.body?.top_objection ?? null)
    } else setState('error')
  }

  return (
    <section aria-label={`Scoreboard, week of ${board.week.label}`} className={cn('flex flex-col gap-6', className)}>
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-[15px] font-medium text-fg">This week</h2>
        <span className="font-mono text-[12px] text-fg-46">{board.week.label}</span>
      </div>
      <dl className="grid grid-cols-3 gap-4">
        {STATS.map((s) => (
          <div key={s.key} className="flex flex-col gap-2">
            <dd data-stat={s.key} className="font-mono text-[40px] leading-none font-medium text-fg tabular-nums max-sm:text-[32px]">
              {board.counts[s.key]}
            </dd>
            <dt className="text-[13px] text-fg-46">{s.label}</dt>
          </div>
        ))}
      </dl>
      <div className="flex flex-col gap-2">
        <label htmlFor="top-objection" className="text-[13px] text-fg-46">
          Top objection
        </label>
        {editable ? (
          <div className="flex items-center gap-3">
            <input
              id="top-objection"
              value={text}
              maxLength={300}
              placeholder="What did you hear most this week?"
              onChange={(e) => {
                setText(e.target.value)
                setState('idle')
              }}
              onBlur={() => void save()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
              className="h-10 min-w-0 flex-1 rounded-lg bg-secondary px-3 text-[14px] text-fg outline-none placeholder:text-fg-46 focus-visible:ring-2 focus-visible:ring-ring"
            />
            <span aria-live="polite" className="w-16 shrink-0 font-mono text-[11px] text-fg-46">
              {state === 'saving' ? 'Saving' : state === 'saved' ? 'Saved' : state === 'error' ? 'Not saved' : ''}
            </span>
          </div>
        ) : (
          <p id="top-objection" className={cn('text-[14px]', saved ? 'text-fg' : 'text-fg-46')}>
            {saved || 'Not written yet.'}
          </p>
        )}
      </div>
    </section>
  )
}
