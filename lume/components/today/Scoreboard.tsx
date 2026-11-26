'use client'

import { useEffect, useState } from 'react'
import type { Scoreboard as Board } from '@/lib/scoreboard/count'
import { sendJson } from '@/lib/validate/client'
import { cn } from '@/lib/utils'

const STATS: { key: keyof Board['counts']; label: string; hint: string }[] = [
  { key: 'conversations', label: 'Conversations', hint: 'Deals that entered Conversation' },
  { key: 'pilots_started', label: 'Pilots started', hint: 'Pilot start date this week' },
  { key: 'pilots_paid', label: 'Pilots paid', hint: 'Deals that entered Paid' },
]

/**
 * This week's scoreboard: three counts from the CRM and the one line the
 * owner types, "top objection". `editable` (the owner's /today) saves the
 * line on blur or Enter; the client portal shows it read-only.
 * Radii nest: 28px card − 20px padding = 8px field.
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
    <section aria-label={`Scoreboard, week of ${board.week.label}`} className={cn('glass flex flex-col gap-5 rounded-[28px] p-5', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="eyebrow">This week</h2>
        <span className="font-mono text-[11.5px] text-fg-46">{board.week.label}</span>
      </div>
      <dl className="grid grid-cols-3 gap-3">
        {STATS.map((s) => {
          const n = board.counts[s.key]
          return (
            <div key={s.key} title={s.hint} className="flex flex-col gap-1">
              <dd data-stat={s.key} className={cn('font-mono text-[40px] leading-none font-medium tabular-nums max-sm:text-[32px]', n > 0 ? 'text-primary light:text-fg' : 'text-fg-46')}>
                {n}
              </dd>
              <dt className="text-[12.5px] text-fg-70">{s.label}</dt>
            </div>
          )
        })}
      </dl>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="top-objection" className="text-[12.5px] text-fg-70">
          Top objection
        </label>
        {editable ? (
          <div className="flex items-center gap-2">
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
              className="h-9 min-w-0 flex-1 rounded-lg bg-secondary px-3 text-[14px] text-fg outline-none placeholder:text-fg-46 focus-visible:ring-2 focus-visible:ring-ring"
            />
            <span aria-live="polite" className="w-12 shrink-0 font-mono text-[11px] text-fg-46">
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
