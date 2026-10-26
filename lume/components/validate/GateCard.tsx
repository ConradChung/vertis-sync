'use client'

import { useId, useState, type Ref } from 'react'
import Link from 'next/link'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { GlassCard } from '@/components/ui/glass-card'
import { Input } from '@/components/ui/input'
import { LFO_MAX_COUNT, LFO_MIN_COUNT } from '@/lib/adapters/pipeline.actions'
import type { GateRow } from '@/lib/db/types'
import { buttonsFor, countChips, KIND_LABEL, type ButtonSpec } from '@/lib/validate/actions'
import { cn } from '@/lib/utils'

const fmt = new Intl.NumberFormat('en-US')

function age(iso: string, now = Date.now()): string {
  const mins = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const h = Math.round(mins / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

export function isValidCount(raw: string): boolean {
  if (!/^\d+$/.test(raw.trim())) return false
  const n = Number(raw)
  return Number.isSafeInteger(n) && n >= LFO_MIN_COUNT && n <= LFO_MAX_COUNT
}

export interface GateCardProps {
  gate: GateRow
  focused: boolean
  busy: boolean
  /** The lfo_count custom input is open on this card. */
  countOpen?: boolean
  onAction: (spec: ButtonSpec, count?: number) => void
  onCountOpenChange?: (open: boolean) => void
  onFocusCard?: () => void
  cardRef?: Ref<HTMLDivElement>
  /** action → reason; the button is disabled and the reason shown. */
  blocked?: Readonly<Record<string, string>>
}

/**
 * One open gate: what it is, its counts, and the same choices the Telegram
 * message offers. Roving tabindex: only the focused card is in the tab order
 * (J/K move it); its accessible name is read when focus lands.
 */
export function GateCard({ gate, focused, busy, countOpen, onAction, onCountOpenChange, onFocusCard, cardRef, blocked }: GateCardProps) {
  const specs = buttonsFor(gate)
  const chips = countChips(gate.counts)
  const titleId = useId()
  const [count, setCount] = useState('')
  const countOk = isValidCount(count)
  const label = `${KIND_LABEL[gate.kind]}: ${gate.title ?? gate.kind}${gate.subtitle ? ` — ${gate.subtitle}` : ''}`
  const firstApprove = specs.findIndex((s) => s.tone === 'approve')

  return (
    <GlassCard
      ref={cardRef}
      size="sm"
      tabIndex={focused ? 0 : -1}
      role="group"
      aria-label={label}
      aria-busy={busy || undefined}
      data-gate={`${gate.kind}:${gate.target_id}`}
      data-focused={focused || undefined}
      onFocus={onFocusCard}
      className={cn(
        'gap-3 px-4 outline-none transition-[border-color] duration-200',
        'focus-visible:ring-2 focus-visible:ring-ring',
        focused && 'border-violet'
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {/* The group header already names the kind; the card shows the age. */}
          <time dateTime={gate.created_at} className="font-mono text-[10px] text-fg-46" suppressHydrationWarning>
            opened {age(gate.created_at)}
          </time>
          <h3 id={titleId} className="mt-1 truncate text-[14px] font-semibold text-fg">
            {gate.title ?? gate.kind}
          </h3>
          {gate.subtitle && <p className="mt-0.5 text-[12px] leading-snug text-fg-70">{gate.subtitle}</p>}
        </div>
        {busy && (
          <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-violet-soft" role="status">
            <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />
            Working…
          </span>
        )}
      </div>

      {chips.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Counts">
          {chips.map((c) => (
            <li key={c.label} className="rounded-[5px] bg-white/6 px-[7px] py-[3px] text-[10px] text-fg-70">
              <span className="font-mono text-fg tabular-nums">{fmt.format(c.value)}</span> {c.label}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-[7px]" aria-labelledby={titleId}>
        {specs.map((s, i) => (
          <Button
            key={`${s.action}:${s.count ?? s.label}`}
            size="sm"
            variant={s.tone === 'reject' ? 'destructive' : i === firstApprove ? 'default' : 'secondary'}
            disabled={busy || Boolean(blocked?.[s.action])}
            title={blocked?.[s.action]}
            data-tone={s.tone}
            onClick={() => (s.needsCount ? onCountOpenChange?.(!countOpen) : onAction(s))}
            aria-expanded={s.needsCount ? Boolean(countOpen) : undefined}
          >
            {s.label}
          </Button>
        ))}
        {gate.kind === 'lume_action' && (
          <Link href={`/actions/${gate.target_id}`} className="ml-auto text-[12px] text-violet-soft hover:text-fg">
            Details →
          </Link>
        )}
      </div>

      {blocked && Object.values(blocked).length > 0 && (
        <p className="text-[11px] text-fg-46">{Object.values(blocked).join(' · ')}</p>
      )}

      {gate.kind === 'lfo_count' && countOpen && (
        <form
          className="flex flex-wrap items-start gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (!countOk || busy) return
            const spec = specs.find((s) => s.needsCount)
            if (spec) onAction(spec, Number(count))
          }}
        >
          <div className="flex flex-col gap-1">
            <label className="sr-only" htmlFor={`${titleId}-count`}>
              Contact count
            </label>
            <Input
              id={`${titleId}-count`}
              inputMode="numeric"
              autoFocus
              placeholder={`${LFO_MIN_COUNT}–${fmt.format(LFO_MAX_COUNT)}`}
              value={count}
              onChange={(e) => setCount(e.target.value)}
              aria-invalid={count !== '' && !countOk}
              aria-describedby={`${titleId}-count-hint`}
              className="h-7 w-36 text-[12px]"
            />
            <span id={`${titleId}-count-hint`} className={cn('text-[10px]', count !== '' && !countOk ? 'text-red' : 'text-fg-46')}>
              Whole number, {fmt.format(LFO_MIN_COUNT)}–{fmt.format(LFO_MAX_COUNT)}
            </span>
          </div>
          <Button type="submit" size="sm" disabled={!countOk || busy}>
            Order {countOk ? fmt.format(Number(count)) : ''}
          </Button>
        </form>
      )}
    </GlassCard>
  )
}
