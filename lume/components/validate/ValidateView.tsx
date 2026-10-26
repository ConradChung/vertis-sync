'use client'

import { AnimatedNumber } from '@/components/ui/animated-number'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { GlassCard } from '@/components/ui/glass-card'
import { SectionTitle, ShimmerBar } from '@/components/overview/parts'
import { BarrierPanel } from '@/components/validate/BarrierPanel'
import { CompanyReview } from '@/components/validate/CompanyReview'
import { GateList } from '@/components/validate/GateList'
import { JobProgress } from '@/components/validate/JobProgress'
import { KeyboardHints } from '@/components/validate/KeyboardHints'
import { RowTable } from '@/components/validate/RowTable'
import { buildCallbackData } from '@/lib/adapters/pipeline.actions'
import type { GateRow } from '@/lib/db/types'
import { buttonsFor, countChips, groupByKind, hotkeyTarget, KIND_LABEL, type ButtonSpec } from '@/lib/validate/actions'
import { sendJson } from '@/lib/validate/client'
import { usePushPreview } from '@/hooks/useJob'
import { clientOutcome } from '@/lib/validate/decideResult'
import { gateKey, parseGateParam } from '@/lib/validate/deepLink'
import { keyIntent, moveFocus } from '@/lib/validate/keyboard'

/** Client-side ceiling for a decision: above the route's 170 s entrypoint wait. */
const DECIDE_CLIENT_TIMEOUT_MS = 200_000

export interface ValidateViewProps {
  gates: GateRow[] | undefined
  error?: unknown
  onRefresh: () => void
  /** Raw `?gate=` value. */
  deepLink?: string | null
}

/**
 * The gate queue. Every decision lands on the same claim a Telegram tap
 * does; whichever arrives first wins and the other sees "already handled".
 */
export function ValidateView({ gates, error, onRefresh, deepLink }: ValidateViewProps) {
  const ordered = useMemo(() => (gates ? groupByKind(gates).flatMap((g) => g.gates) : []), [gates])
  const keys = useMemo(() => ordered.map(gateKey), [ordered])

  const [focusedKey, setFocusedKey] = useState<string | null>(null)
  const lastIndex = useRef(0)
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const busyRef = useRef(busy)
  busyRef.current = busy
  const [countOpenKey, setCountOpenKey] = useState<string | null>(null)
  const [pickerTick, setPickerTick] = useState(0)
  const [editTick, setEditTick] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const [announce, setAnnounce] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  /** A/R/E act only after the owner put focus on a card (click, Tab, J/K, deep link). */
  const explicitFocus = useRef(false)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  // The focused gate; when it closes, focus stays at the same position.
  let focusIdx = focusedKey ? keys.indexOf(focusedKey) : -1
  if (focusIdx < 0 && keys.length) focusIdx = Math.min(lastIndex.current, keys.length - 1)
  if (focusIdx >= 0) lastIndex.current = focusIdx
  const focused = focusIdx >= 0 ? ordered[focusIdx] : undefined
  const effectiveKey = focused ? gateKey(focused) : null
  const pushPreview = usePushPreview(focused?.kind === 'push_review' ? focused.target_id : null).data?.preview
  const blockedFor = (g: GateRow) =>
    g.kind === 'push_review' && focused && gateKey(g) === effectiveKey && pushPreview && pushPreview.eligible === 0
      ? { push_to_instantly: 'Nothing to push — the preview shows 0 eligible leads.' }
      : undefined

  const focusCard = useCallback((key: string, scroll: ScrollLogicalPosition = 'nearest') => {
    explicitFocus.current = true
    setFocusedKey(key)
    requestAnimationFrame(() => {
      // Looked up in the DOM at focus time: callback refs churn on re-render.
      const el = listRef.current?.querySelector<HTMLElement>(`[data-gate="${key}"]`)
      if (!el) return
      el.focus({ preventScroll: true })
      el.scrollIntoView({ block: scroll, behavior: 'smooth' })
    })
  }, [])

  // The focused gate closed: move focus to the card now at its position (if
  // focus was in the list) and say so politely.
  const prevKeys = useRef<string[]>([])
  useEffect(() => {
    const prev = prevKeys.current
    prevKeys.current = keys
    if (!focusedKey || !prev.includes(focusedKey) || keys.includes(focusedKey)) return
    const remaining = keys.length
    setAnnounce(`Gate closed, ${remaining} remaining`)
    // The closed card took focus with it: the active element is now body (or,
    // in some engines, the detached card itself).
    const active = document.activeElement
    const inList = !active || !active.isConnected || active === document.body || Boolean(listRef.current?.contains(active))
    if (!remaining) return setFocusedKey(null)
    const next = keys[Math.min(prev.indexOf(focusedKey), remaining - 1)]
    if (inList && explicitFocus.current) focusCard(next)
    else setFocusedKey(next)
  }, [keys, focusedKey, focusCard])

  // Deep link: once per value, after the first load.
  const handledLink = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    if (!gates || handledLink.current === deepLink) return
    handledLink.current = deepLink
    if (!deepLink) return
    const ref = parseGateParam(deepLink)
    if (!ref) return setNotice("That link doesn't point to a gate.")
    if (keys.includes(ref.key)) {
      setNotice(null)
      focusCard(ref.key, 'center')
    } else {
      setNotice('This gate is already closed — handled here or in Telegram.')
    }
  }, [gates, deepLink, keys, focusCard])

  const setBusyKey = (key: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })

  const run = useCallback(
    async (gate: GateRow, spec: ButtonSpec, count?: number) => {
      const key = gateKey(gate)
      if (busyRef.current.has(key)) return
      setFocusedKey(key)

      if (spec.mode === 'panel') {
        setPickerTick((t) => t + 1)
        return
      }
      if (spec.needsCount && count === undefined) {
        setCountOpenKey(key)
        return
      }

      setBusyKey(key, true)
      try {
        if (spec.mode === 'decide') {
          let callbackData: string
          try {
            callbackData = buildCallbackData(spec.action, gate.target_id, spec.count ?? count)
          } catch {
            toast.error('That choice is not valid for this gate')
            return
          }
          const r = await sendJson('/api/gates/decide', { callback_data: callbackData }, { timeoutMs: DECIDE_CLIENT_TIMEOUT_MS })
          const outcome = r.status === 0 ? (r.aborted ? 'pending' : 'error') : clientOutcome(r.status, r.body)
          const err = (r.body as { error?: string } | null)?.error
          if (outcome === 'done') toast.success(`${spec.label} — done`)
          else if (outcome === 'sent') toast.success(`${spec.label} sent`, { description: 'Telegram will report the result.' })
          else if (outcome === 'already_handled') toast.info('Already handled — refreshed')
          else if (outcome === 'pending') {
            toast.info('Still working — will refresh')
            timers.current.push(setTimeout(onRefresh, 15_000), setTimeout(onRefresh, 60_000))
          } else if (err === 'pipeline_not_configured') toast.error('Pipeline entrypoint not configured', { description: 'Set LUME_ACTION_SECRET.' })
          else toast.error("Couldn't reach the pipeline", { description: 'Nothing was claimed — the Telegram button still works.' })
          if (spec.needsCount && outcome !== 'error') setCountOpenKey(null)
        } else if (spec.mode === 'create_action' && spec.actionKind) {
          const r = await sendJson<{ error?: string }>('/api/actions', { kind: spec.actionKind, payload: { job_id: gate.target_id } })
          if (r.status === 201) toast.success('Confirmation requested', { description: 'Confirm it here or in Telegram — nothing is pushed until then.' })
          else if (r.status === 409 && r.body?.error === 'duplicate') toast.info('A confirmation is already waiting for this job')
          else if (r.status === 409 && r.body?.error === 'nothing_to_push') toast.info('Nothing to push — every lead is filtered out')
          else if (r.status === 409) toast.info('This job is no longer ready to push — refreshed')
          else toast.error("Couldn't request the confirmation")
        } else if (spec.mode === 'action_decide') {
          const r = await sendJson(`/api/actions/${gate.target_id}/decide`, { decision: spec.action === 'lume_ok' ? 'approve' : 'reject' })
          if (r.status === 404) toast.error('Confirmation endpoint not available yet')
          else if (r.status === 409) toast.info('Already handled — refreshed')
          else if (r.status >= 200 && r.status < 300) toast.success(spec.action === 'lume_ok' ? 'Confirmed' : 'Cancelled')
          else toast.error("Couldn't record the decision")
        }
      } finally {
        setBusyKey(key, false)
        onRefresh()
      }
    },
    [onRefresh]
  )

  // Keyboard: J/K/A/R/E, ignored while typing.
  const stateRef = useRef({ keys, focusIdx, focused, run, focusCard })
  stateRef.current = { keys, focusIdx, focused, run, focusCard }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const intent = keyIntent({
        key: e.key,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: e.altKey,
        repeat: e.repeat,
        targetTag: t?.tagName,
        targetEditable: t?.isContentEditable,
      })
      if (!intent) return
      // A dialog/menu owns the keyboard while open.
      if (t?.closest('[role="dialog"],[role="menu"],[role="listbox"]')) return
      const s = stateRef.current
      if (!s.keys.length) return
      const active = document.activeElement
      const inList = Boolean(active && listRef.current?.contains(active))
      if (intent === 'next' || intent === 'prev') {
        // From the page body or inside the list; never from another widget.
        if (!inList && active && active !== document.body) return
        e.preventDefault()
        const i = explicitFocus.current ? moveFocus(s.focusIdx, s.keys.length, intent) : 0
        if (i >= 0) s.focusCard(s.keys[i])
        return
      }
      // A/R/E: only on a card the owner focused, with focus still in the list.
      if (!explicitFocus.current || !inList || !s.focused) return
      e.preventDefault()
      if (intent === 'edit') {
        if (s.focused.target_table === 'validation_jobs') setEditTick((x) => x + 1)
        else toast.info('No lead rows behind this gate')
        return
      }
      const spec = hotkeyTarget(buttonsFor(s.focused), intent)
      if (spec) void s.run(s.focused, spec)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!gates && error) {
    return (
      <GlassCard className="flex-row items-center justify-between px-[18px]" role="alert">
        <span className="text-[13px] text-fg-70">Couldn&apos;t load the queue.</span>
        <Button size="sm" variant="secondary" onClick={onRefresh}>
          Retry
        </Button>
      </GlassCard>
    )
  }
  if (!gates) return <ValidateSkeleton />

  const isJob = focused?.target_table === 'validation_jobs'

  return (
    <div className="flex flex-col gap-4">
      {notice && (
        <p className="flex items-center gap-3 text-[12px] text-amber" role="status">
          {notice}
          <button type="button" className="text-violet-soft hover:text-fg" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </p>
      )}
      {error != null && (
        <p className="flex items-center gap-3 text-[12px] text-amber" role="status">
          Couldn&apos;t refresh — showing the last data.
          <button type="button" onClick={onRefresh} className="text-violet-soft hover:text-fg">
            Retry
          </button>
        </p>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>
      {gates.length === 0 ? (
        <GlassCard className="items-center gap-2 py-12 text-center">
          <p className="text-[15px] font-semibold text-fg">Nothing waiting on you</p>
          <p className="text-[12px] text-fg-46">New gates show up here and in Telegram the moment a pipeline stops for a decision.</p>
        </GlassCard>
      ) : (
        <>
          <div className="grid items-start gap-4 lg:grid-cols-[1.25fr_1fr]">
            <div ref={listRef}>
            <GateList
              gates={gates}
              blockedFor={blockedFor}
              focusedKey={effectiveKey}
              busyKeys={busy}
              countOpenKey={countOpenKey}
              onAction={(g, s, c) => void run(g, s, c)}
              onCountOpenChange={(k, open) => setCountOpenKey(open ? k : null)}
              onFocusGate={(k) => {
                explicitFocus.current = true
                setFocusedKey(k)
              }}
            />
            </div>
            {focused && (
              <div className="flex flex-col gap-4 lg:sticky lg:top-[96px]" aria-label="Gate detail">
                {isJob ? <JobProgress jobId={focused.target_id} /> : <GateFacts gate={focused} />}
                {(focused.kind === 'campaign_choice' || focused.kind === 'push_review') && (
                  <BarrierPanel gate={focused} pickerFocusTick={pickerTick} />
                )}
                {focused.kind === 'push_review' && <CompanyReview jobId={focused.target_id} />}
              </div>
            )}
          </div>
          {focused && isJob && <RowTable jobId={focused.target_id} editRequest={editTick} />}
        </>
      )}
      <KeyboardHints />
    </div>
  )
}

/** Detail for gates with no per-row data (job batches, ingests, orders, actions). */
function GateFacts({ gate }: { gate: GateRow }) {
  const chips = countChips(gate.counts)
  const url = typeof gate.counts?.apollo_url === 'string' ? gate.counts.apollo_url : null
  return (
    <GlassCard className="gap-0 py-0" aria-label="Gate detail">
      <SectionTitle title={gate.title ?? KIND_LABEL[gate.kind]}>
        <span>{KIND_LABEL[gate.kind]}</span>
      </SectionTitle>
      <div className="flex flex-col gap-3 px-[18px] pb-[18px] text-[12px] text-fg-70">
        {gate.subtitle && <p>{gate.subtitle}</p>}
        {chips.length > 0 && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px]">
            {chips.map((c) => (
              <div key={c.label} className="contents">
                <dt className="text-fg-46">{c.label}</dt>
                <dd className="text-right font-mono text-fg">
                  <AnimatedNumber value={c.value} />
                </dd>
              </div>
            ))}
          </dl>
        )}
        {url && (
          <a href={url} target="_blank" rel="noreferrer" className="truncate text-violet-soft hover:text-fg">
            Apollo search ↗
          </a>
        )}
        <p className="text-[11px] text-fg-46">
          {gate.telegram_message_id ? 'The Telegram prompt is live too' : 'Also decidable from Telegram'} — whichever tap lands first wins.
        </p>
      </div>
    </GlassCard>
  )
}

export function ValidateSkeleton() {
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[1.25fr_1fr]" aria-busy="true" aria-label="Loading gates">
      <div className="flex flex-col gap-3">
        {[0, 1, 2].map((i) => (
          <GlassCard key={i} size="sm" className="gap-3 px-4" aria-hidden>
            <ShimmerBar className="h-3 w-24" />
            <ShimmerBar className="h-4 w-2/3" />
            <ShimmerBar className="h-7 w-1/2" />
          </GlassCard>
        ))}
      </div>
      <GlassCard className="gap-3 px-[18px]" aria-hidden>
        <ShimmerBar className="h-3 w-28" />
        <ShimmerBar className="h-3 w-full" />
        <ShimmerBar className="h-10 w-full" />
      </GlassCard>
    </div>
  )
}
