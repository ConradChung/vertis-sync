'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { GlassCard } from '@/components/ui/glass-card'
import { ShimmerBar } from '@/components/overview/parts'
import { TagChip } from '@/components/tags/TagChip'
import { AlsoNeedsYou } from '@/components/progress/AlsoNeedsYou'
import { FlowChart } from '@/components/progress/FlowChart'
import { OtherActivity } from '@/components/progress/OtherActivity'
import { RunDot, RunSwitcher } from '@/components/progress/RunSwitcher'
import { StepDetail } from '@/components/progress/StepDetail'
import { KeyboardHints } from '@/components/validate/KeyboardHints'
import { LeadsPreview, RenamableName } from '@/components/validate/ValidatedPreview'
import { useGateRunner } from '@/hooks/useGateRunner'
import { usePushPreview } from '@/hooks/useJob'
import type { GateRow, JobProgress } from '@/lib/db/types'
import { buildFlow, focusStep, type PushRoute, type StepId } from '@/lib/progress/flow'
import type { ProgressPayload } from '@/lib/progress/model'
import { gatesForRun, isIngestRun, runOfGate, runStatus, type DeepLinkTarget, type RunSummary } from '@/lib/progress/runs'
import { buttonsFor, hotkeyTarget } from '@/lib/validate/actions'
import { gateKey } from '@/lib/validate/deepLink'
import { keyIntent, moveFocus } from '@/lib/validate/keyboard'

const fmt = new Intl.NumberFormat('en-US')
const SURFACE = 'border-transparent'
const REVIEWING = new Set(['configuring', 'reviewing_company'])

export interface ProgressBoardProps {
  gates: GateRow[] | undefined
  gatesError?: unknown
  onRefresh: () => void
  runs: readonly RunSummary[]
  /** The runs list has loaded (an empty list then means "no runs"). */
  runsLoaded: boolean
  selectedId: string | null
  onSelectRun: (id: string) => void
  /** The selected run's job (undefined while loading; null for a CSV still at approval). */
  job: JobProgress | null | undefined
  jobError?: unknown
  progress: ProgressPayload | undefined
  /** `?gate=` resolved (lib/progress/runs.resolveGateLink). */
  gateLink?: DeepLinkTarget | null
  /** The selected run's Instantly campaign status label, when known. */
  campaignStatus?: string | null
}

/**
 * Progress: the run switcher, the selected run's flow, one step panel (the
 * only place that run's buttons live), its leads; everything else waiting on
 * the owner and other activity on the side. J/K move between the gates on
 * screen, A/R decide the focused one (never a spending or confirmation
 * button), E opens the row editor.
 */
export function ProgressBoard(props: ProgressBoardProps) {
  const { gates, gatesError, onRefresh, runs, runsLoaded, selectedId, onSelectRun, job, jobError, progress, gateLink, campaignStatus } = props
  const all = useMemo(() => gates ?? [], [gates])
  const run = runs.find((r) => r.id === selectedId) ?? null
  const runGates = useMemo(() => (selectedId ? gatesForRun(all, selectedId) : []), [all, selectedId])
  // The push preview (instantly-push) while the run is at review / confirm: blocks an empty push and tells direct from lead-bank routing.
  const previewJob = run?.kind === 'job' && job && REVIEWING.has(job.instantly_status ?? '') ? job.id : null
  const pushPreview = usePushPreview(previewJob).data?.preview
  const route = (pushPreview as PushRoute | undefined) ?? null
  const nodes = useMemo(
    () => (run && (job !== undefined || run.kind === 'ingest') ? buildFlow({ job: run.kind === 'ingest' ? null : (job ?? null), gates: runGates, campaignStatus, route }) : []),
    [run, job, runGates, campaignStatus, route]
  )

  // Step: the owner's pick for this run, else the one waiting on them / running.
  const [picked, setPicked] = useState<{ runId: string; step: StepId } | null>(null)
  const auto = nodes.length ? focusStep(nodes) : null
  const stepId = picked && picked.runId === selectedId && nodes.some((n) => n.id === picked.step) ? picked.step : auto
  const stepIndex = nodes.findIndex((n) => n.id === stepId)
  const node = stepIndex >= 0 ? nodes[stepIndex] : null

  const statusOf = useCallback((r: RunSummary) => runStatus(r, all), [all])
  const alsoGates = useMemo(() => all.filter((g) => runOfGate(g) === null), [all])
  const otherRuns = useMemo(() => {
    const out: { run: RunSummary; gate: GateRow }[] = []
    for (const g of all) {
      const id = runOfGate(g)
      if (!id || id === selectedId || out.some((o) => o.run.id === id)) continue
      const r = runs.find((x) => x.id === id)
      if (r) out.push({ run: r, gate: g })
    }
    return out
  }, [all, runs, selectedId])

  // The gates on screen, in order: the step's own, then the side list.
  const onScreen = useMemo(() => [...(node?.gate ? [node.gate] : []), ...alsoGates], [node, alsoGates])
  const keys = useMemo(() => onScreen.map(gateKey), [onScreen])

  const runner = useGateRunner(onRefresh)
  const [focusedKey, setFocusedKey] = useState<string | null>(null)
  const lastIndex = useRef(0)
  const [editTick, setEditTick] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const [announce, setAnnounce] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  /** A/R/E act only after the owner put focus on a gate (click, Tab, J/K, deep link). */
  const explicitFocus = useRef(false)

  let focusIdx = focusedKey ? keys.indexOf(focusedKey) : -1
  if (focusIdx < 0 && keys.length) focusIdx = Math.min(lastIndex.current, keys.length - 1)
  if (focusIdx >= 0) lastIndex.current = focusIdx
  const focused = focusIdx >= 0 ? onScreen[focusIdx] : undefined
  const effectiveKey = focused ? gateKey(focused) : null

  const blockedFor = useCallback(
    (g: GateRow) => (g.kind === 'push_review' && pushPreview && pushPreview.eligible === 0 ? { push_to_instantly: 'Nothing to push — the preview shows 0 eligible leads.' } : undefined),
    [pushPreview]
  )

  const focusGate = useCallback((key: string, scroll: ScrollLogicalPosition = 'nearest') => {
    explicitFocus.current = true
    setFocusedKey(key)
    requestAnimationFrame(() => {
      const el = rootRef.current?.querySelector<HTMLElement>(`[data-gate="${key}"]`)
      if (!el) return
      el.focus({ preventScroll: true })
      el.scrollIntoView({ block: scroll, behavior: 'smooth' })
    })
  }, [])

  // The focused gate closed: focus the gate now at its position (if focus was on a gate) and say so.
  const prevKeys = useRef<string[]>([])
  useEffect(() => {
    const prev = prevKeys.current
    prevKeys.current = keys
    if (!focusedKey || !prev.includes(focusedKey) || keys.includes(focusedKey)) return
    const remaining = keys.length
    setAnnounce(`Gate closed, ${remaining} remaining`)
    const active = document.activeElement
    const onGate = !active || !active.isConnected || active === document.body || Boolean(active.closest?.('[data-gate]'))
    if (!remaining) return setFocusedKey(null)
    const next = keys[Math.min(prev.indexOf(focusedKey), remaining - 1)]
    if (onGate && explicitFocus.current) focusGate(next)
    else setFocusedKey(next)
  }, [keys, focusedKey, focusGate])

  // ?gate=: open its run at its step (ProgressScreen selects the run), then focus the gate once it is on screen.
  const handledLink = useRef<DeepLinkTarget | null | undefined>(undefined)
  const pendingFocus = useRef<string | null>(null)
  useEffect(() => {
    if (!gates || handledLink.current === gateLink) return
    handledLink.current = gateLink
    if (!gateLink) return
    if (gateLink.state === 'invalid') return setNotice("That link doesn't point to a gate.")
    if (gateLink.runId && gateLink.step) setPicked({ runId: gateLink.runId, step: gateLink.step })
    if (gateLink.state === 'closed') return setNotice('This gate is already closed — handled here or in Telegram.')
    setNotice(null)
    pendingFocus.current = gateLink.key
  }, [gates, gateLink])
  useEffect(() => {
    const k = pendingFocus.current
    if (k && keys.includes(k)) {
      pendingFocus.current = null
      focusGate(k, 'center')
    }
  }, [keys, focusGate])

  // Keyboard: J/K/A/R/E, ignored while typing.
  const stateRef = useRef({ keys, focusIdx, focused, run: runner.run, focusGate })
  stateRef.current = { keys, focusIdx, focused, run: runner.run, focusGate }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const intent = keyIntent({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, repeat: e.repeat, targetTag: t?.tagName, targetEditable: t?.isContentEditable })
      if (!intent) return
      if (t?.closest?.('[role="dialog"],[role="menu"],[role="listbox"]')) return
      const s = stateRef.current
      if (!s.keys.length) return
      const active = document.activeElement
      const onGate = Boolean(active?.closest?.('[data-gate]') && rootRef.current?.contains(active))
      if (intent === 'next' || intent === 'prev') {
        if (!onGate && active && active !== document.body) return
        e.preventDefault()
        const i = explicitFocus.current ? moveFocus(s.focusIdx, s.keys.length, intent) : 0
        if (i >= 0) s.focusGate(s.keys[i])
        return
      }
      if (!explicitFocus.current || !onGate || !s.focused) return
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

  const gateProps = {
    focusedKey: effectiveKey,
    busyKeys: runner.busy,
    countOpenKey: runner.countOpenKey,
    onAction: (g: GateRow, spec: Parameters<typeof runner.run>[1], count?: number) => {
      setFocusedKey(gateKey(g))
      void runner.run(g, spec, count)
    },
    onCountOpenChange: (key: string, open: boolean) => runner.setCountOpenKey(open ? key : null),
    onFocusGate: (key: string) => {
      explicitFocus.current = true
      setFocusedKey(key)
    },
  }

  const selectRun = (id: string) => {
    setNotice(null)
    onSelectRun(id)
  }

  const nothingAtAll = runsLoaded && runs.length === 0 && gates !== undefined && all.length === 0

  return (
    <div ref={rootRef} className="flex flex-col gap-4">
      {notice && (
        <p className="flex items-center gap-3 text-[12px] text-fg-70" role="status">
          {notice}
          <button type="button" className="text-fg-46 underline-offset-2 hover:text-fg hover:underline" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </p>
      )}
      {gatesError != null && (
        <p className="flex items-center gap-3 text-[12px] text-fg-70" role="status">
          {gates ? 'Couldn’t refresh what’s waiting on you — showing the last data.' : 'Couldn’t load what’s waiting on you.'}
          <Button size="xs" variant="secondary" onClick={onRefresh}>
            Retry
          </Button>
        </p>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>

      <RunSwitcher loaded={runsLoaded} runs={runs} selectedId={selectedId} statusOf={statusOf} onSelect={selectRun} />

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,380px)]">
        <div className="flex min-w-0 flex-col gap-4">
          {nothingAtAll ? (
            <GlassCard className={`${SURFACE} items-center gap-2 py-14 text-center`}>
              <p className="text-[15px] font-semibold text-fg">Nothing running, nothing waiting on you.</p>
              <p className="text-[12px] text-fg-46">Import a CSV and its run shows up here, step by step.</p>
            </GlassCard>
          ) : !run ? (
            <RunSkeleton missing={runsLoaded && Boolean(selectedId) && job === null} />
          ) : (
            <GlassCard className={`${SURFACE} gap-7 px-4 py-5 sm:px-6 sm:py-6`} aria-label="Selected run">
              <RunHeader run={run} job={run.kind === 'job' ? job : null} status={statusOf(run)} />
              {nodes.length ? (
                <>
                  <FlowChart nodes={nodes} selected={stepId ?? nodes[0].id} onSelect={(s) => selectedId && setPicked({ runId: selectedId, step: s })} />
                  {node && <StepDetail node={node} index={stepIndex + 1} count={nodes.length} run={run} job={run.kind === 'job' ? (job ?? null) : null} route={route} pickerTick={runner.pickerTick} blockedFor={blockedFor} {...gateProps} />}
                </>
              ) : jobError ? (
                <p className="text-[12px] text-fg-70" role="alert">
                  Couldn&apos;t load this run.
                </p>
              ) : (
                <div className="flex flex-col gap-3" aria-busy="true">
                  <ShimmerBar className="h-8 w-full" />
                  <ShimmerBar className="h-24 w-full" />
                </div>
              )}
            </GlassCard>
          )}
          {run?.kind === 'job' && (
            <GlassCard className={`${SURFACE} gap-0 py-0`}>
              <LeadsPreview jobId={run.id} editRequest={editTick} heading={<h2 className="mr-2 text-[13px] font-medium text-fg">Leads</h2>} />
            </GlassCard>
          )}
        </div>

        <aside className="flex flex-col gap-4 xl:sticky xl:top-[96px]" aria-label="Everything else">
          <GlassCard className={`${SURFACE} gap-0 px-2 py-3`}>
            <AlsoNeedsYou loading={gates === undefined && gatesError == null} gates={alsoGates} otherRuns={otherRuns} onOpenRun={selectRun} {...gateProps} />
          </GlassCard>
          {progress && (progress.running.some((i) => i.kind !== 'validation') || progress.recent.some((i) => i.kind !== 'validation')) && (
            <GlassCard className={`${SURFACE} gap-0 px-2 py-2`}>
              <OtherActivity data={progress} />
            </GlassCard>
          )}
        </aside>
      </div>
      <KeyboardHints />
    </div>
  )
}

const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })

function RunHeader({ run, job, status }: { run: RunSummary; job: JobProgress | null | undefined; status: ReturnType<typeof runStatus> }) {
  const name = run.kind === 'job' ? job?.display_name?.trim() || job?.filename || run.title : run.title
  const word = { needs_you: 'Waiting on you', running: 'Running', failed: 'Failed', done: 'Done' }[status]
  return (
    <header className="flex flex-col gap-1.5">
      <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px] text-fg-46">
        <span className="inline-flex items-center gap-1.5">
          <RunDot status={status} />
          <span className={status === 'needs_you' || status === 'running' ? 'text-lime' : status === 'failed' ? 'text-red' : 'text-fg-70'}>{word}</span>
        </span>
        <span className="font-mono tabular-nums">{day(job?.created_at ?? run.created_at)}</span>
        <span className="font-mono tabular-nums">{fmt.format(job?.total_rows ?? run.total_rows)} rows</span>
        {run.kind === 'job' && job?.filename && name !== job.filename && <span className="max-w-[24ch] truncate">{job.filename}</span>}
        <TagChip
          table={run.kind === 'job' ? 'validation_jobs' : 'telegram_ingests'}
          id={isIngestRun(run.id) ? run.id.slice('ingest:'.length) : run.id}
          verticalId={run.vertical_id ?? job?.vertical_id}
          name={run.vertical_name}
          revalidate={['/api/validation-jobs/runs?limit=100', '/api/gates']}
        />
      </p>
      <h2 className="min-w-0 text-[22px] leading-tight font-semibold tracking-tight text-fg sm:text-[26px]">
        {run.kind === 'job' ? <RenamableName jobId={run.id} name={name} className="max-w-full" /> : name}
      </h2>
    </header>
  )
}

function RunSkeleton({ missing }: { missing?: boolean }) {
  if (missing)
    return (
      <GlassCard className={`${SURFACE} items-center gap-2 py-12 text-center`}>
        <p className="text-[14px] font-semibold text-fg">That run doesn&apos;t exist.</p>
        <p className="text-[12px] text-fg-46">Pick one from the runs above.</p>
      </GlassCard>
    )
  return (
    <GlassCard className={`${SURFACE} gap-5 px-6 py-6`} aria-busy="true" aria-label="Loading run">
      <ShimmerBar className="h-3 w-40" />
      <ShimmerBar className="h-6 w-2/3" />
      <ShimmerBar className="h-12 w-full" />
      <ShimmerBar className="h-24 w-full" />
    </GlassCard>
  )
}

export function ProgressSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading progress">
      <div className="flex gap-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-[76px] w-[212px] shrink-0 rounded-xl bg-(--glass-fill) p-3.5 backdrop-blur-xl">
            <ShimmerBar className="h-3 w-3/4" />
          </div>
        ))}
      </div>
      <RunSkeleton />
    </div>
  )
}
