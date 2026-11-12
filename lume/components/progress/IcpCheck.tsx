'use client'

import { useEffect, useId, useState } from 'react'
import useSWR from 'swr'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ShimmerBar } from '@/components/overview/parts'
import { StepGate, type StepGateProps } from '@/components/progress/StepDetail'
import { Bar } from '@/components/validate/JobProgress'
import { fetchJson } from '@/hooks/fetcher'
import type { CheckOverview } from '@/lib/companyCheck/action'
import type { CheckScope, Fit, PropertyType } from '@/lib/companyCheck/model'
import {
  checkGateFor,
  companyCheckUrl,
  defaultScope,
  doorsText,
  FIT_LABEL,
  fitRows,
  hostOf,
  requestOutcome,
  runProgress,
  SCOPE_LABEL,
  TYPE_LABEL,
  typeRows,
  type BreakdownRow,
} from '@/lib/companyCheck/view'
import type { GateRow } from '@/lib/db/types'
import { sendJson } from '@/lib/validate/client'
import { cn } from '@/lib/utils'

const fmt = new Intl.NumberFormat('en-US')
const usd = (n: number | null | undefined) => (n == null ? '—' : `$${n.toFixed(2)}`)
const PAGE = 50
const FIT_TONE: Record<Fit, string> = { fit: 'text-lime', not_fit: 'text-red', unclear: 'text-fg-46' }

export interface IcpCheckProps extends StepGateProps {
  jobId: string
  /** Leads this job put in the lead bank: > 0 makes "Still sending" the default scope. */
  banked: number | null | undefined
  gates: readonly GateRow[] | undefined
  /** Re-read the gates (the approval shows up there) after a request. */
  onRequested: () => void
}

/** A pill toggle (aria-pressed buttons), the CompanyReview look. */
function Pills<T extends string>({ label, value, options, onChange, disabled }: { label: string; value: T; options: readonly { v: T; label: string }[]; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div role="group" aria-label={label} className="flex w-fit flex-wrap gap-1 rounded-lg bg-white/5 p-0.5">
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          aria-pressed={value === o.v}
          disabled={disabled}
          onClick={() => onChange(o.v)}
          className={cn(
            'rounded-md px-2.5 py-1 text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
            value === o.v ? 'bg-accent text-fg' : 'text-fg-46 hover:text-fg'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Breakdown<K extends string>({ title, rows, active, onPick, tone }: { title: string; rows: BreakdownRow<K>[]; active: K | null; onPick: (k: K | null) => void; tone?: (k: K) => string }) {
  if (!rows.length) return null
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <p className="text-[11px] text-fg-46">{title}</p>
      <div className="flex flex-col">
        {rows.map((r) => (
          <button
            key={r.key}
            type="button"
            aria-pressed={active === r.key}
            onClick={() => onPick(active === r.key ? null : r.key)}
            className={cn(
              'grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-3 rounded-md px-2 py-1 text-left text-[12px] outline-none hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-ring',
              active === r.key && 'bg-white/[0.06]'
            )}
          >
            <span className={cn('truncate', tone?.(r.key) ?? 'text-fg')}>{r.label}</span>
            <span className="font-mono text-fg tabular-nums">{fmt.format(r.companies)}</span>
            <span className="w-[9ch] text-right font-mono text-fg-46 tabular-nums">{fmt.format(r.leads)} leads</span>
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * Progress → ICP check for a completed validation job: one web-research call
 * per distinct company (what it does, property type, doors, ICP fit). The
 * ICP (Kaspen preset for a Kaspen job) and scope drive a live quote from
 * GET /api/company-check; "Request check" files a `company_check` pending
 * action (POST /api/actions), which always waits for the owner's Confirm,
 * shown right here. A run shows its progress, breakdowns and per-company table.
 */
export function IcpCheck({ jobId, banked, gates, onRequested, ...gateProps }: IcpCheckProps) {
  const icpId = useId()
  const [scope, setScope] = useState<CheckScope>(() => defaultScope(banked))
  const [icp, setIcp] = useState<string | null>(null)
  const [debounced, setDebounced] = useState<string | null>(null)
  const [fit, setFit] = useState<Fit | null>(null)
  const [type, setType] = useState<PropertyType | null>(null)
  const [page, setPage] = useState(0)
  const [busy, setBusy] = useState(false)
  const gate = checkGateFor(gates, jobId)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(icp), 500)
    return () => clearTimeout(t)
  }, [icp])
  useEffect(() => setPage(0), [fit, type, scope, debounced])

  const url = companyCheckUrl({ jobId, icp: debounced, scope, fit, type, limit: PAGE, offset: page * PAGE })
  const q = useSWR<CheckOverview>(url, fetchJson, {
    keepPreviousData: true,
    refreshInterval: (d) => (d?.run?.status === 'running' ? 5_000 : 0),
  })
  const o = q.data
  // The first answer carries the server's pick (job ICP, Kaspen preset or default): prefill the box once.
  useEffect(() => {
    if (icp === null && o?.icp) {
      setIcp(o.icp)
      setDebounced(o.icp)
    }
  }, [icp, o?.icp])

  const typing = icp !== null && icp !== debounced
  const icpOk = (icp ?? '').trim().length >= 3 && (icp ?? '').length <= 1000
  const run = o?.run ?? null
  const running = run?.status === 'running'

  const request = async () => {
    if (busy || !icp) return
    setBusy(true)
    try {
      const r = await sendJson<{ error?: string }>('/api/actions', { kind: 'company_check', payload: { job_id: jobId, icp: icp.trim(), scope } })
      const out = requestOutcome(r.status, r.body)
      toast[out.tone](out.message)
    } finally {
      setBusy(false)
      onRequested()
      void q.mutate()
    }
  }

  const presetOptions = o
    ? [...(o.presets.kaspen ? [{ label: 'Kaspen preset', text: o.presets.kaspen_icp }] : []), { label: 'Generic property manager', text: o.presets.default_icp }]
    : []

  return (
    <section aria-label="ICP check" className="flex min-w-0 flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h2 className="text-[17px] leading-tight font-semibold tracking-tight text-fg">ICP check</h2>
        <p className="max-w-[68ch] text-[12.5px] leading-relaxed text-fg-70">
          One web lookup per company: what it does, what it manages (residential, multifamily, commercial), roughly how many doors, and whether it fits. Nothing is spent until you confirm.
        </p>
      </header>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label htmlFor={icpId} className="text-[11px] text-fg-46">
            Ideal customer
          </label>
          <div className="flex flex-wrap gap-1.5">
            {presetOptions.map((p) => (
              <Button key={p.label} size="xs" variant="ghost" aria-pressed={icp === p.text} onClick={() => setIcp(p.text)}>
                {p.label}
              </Button>
            ))}
          </div>
        </div>
        {icp === null ? (
          <ShimmerBar className="h-16 w-full" />
        ) : (
          <Textarea id={icpId} value={icp} maxLength={1000} rows={3} onChange={(e) => setIcp(e.target.value)} aria-invalid={!icpOk || undefined} className="bg-white/[0.03] text-[13px] leading-relaxed" />
        )}
        <Pills
          label="Which leads"
          value={scope}
          onChange={setScope}
          options={[
            { v: 'sending', label: SCOPE_LABEL.sending },
            { v: 'all', label: SCOPE_LABEL.all },
          ]}
        />
      </div>

      <Quote o={o} error={q.error} stale={typing || q.isValidating} />

      {gate ? (
        <StepGate gate={gate} {...gateProps}>
          <p className="text-[12px] text-lime">Waiting for your confirmation — this spends money.</p>
          {gate.subtitle && <p className="text-[12.5px] leading-relaxed text-fg">{gate.subtitle}</p>}
        </StepGate>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" disabled={busy || !o || typing || !icpOk || running || !o.unchecked} onClick={() => void request()}>
            Request check{o && o.unchecked ? ` · ~${usd(o.estimate.usd)}` : ''}
          </Button>
          <span className="text-[11px] text-fg-46">
            {running ? 'A check is running.' : o && !o.unchecked ? 'Every company in this scope is already checked for this ICP.' : 'Asks for your confirmation first.'}
          </span>
        </div>
      )}

      {run && o && (
        <RunView o={o} fit={fit} type={type} onFit={setFit} onType={setType} page={page} onPage={setPage} />
      )}
    </section>
  )
}

function Quote({ o, error, stale }: { o: CheckOverview | undefined; error: unknown; stale: boolean }) {
  if (error && !o) return <p className="text-[12px] text-amber" role="alert">Couldn&apos;t load the quote.</p>
  if (!o) return <ShimmerBar className="h-20 w-full" />
  const rows: [string, string][] = [
    ['Leads in scope', `${fmt.format(o.plan.valid_leads)}${o.scope === 'sending' ? ` of ${fmt.format(o.plan.all_valid_leads)} valid` : ''}`],
    ['Companies', `${fmt.format(o.plan.companies)} distinct`],
    ['Already checked', `${fmt.format(o.plan.cached)} (free)`],
    ['To check', fmt.format(o.unchecked)],
    ['Estimate', `${usd(o.estimate.usd)} · $${o.estimate.unit_usd} per company${o.estimate.per_lead_usd != null ? ` · $${o.estimate.per_lead_usd.toFixed(4)} per lead` : ''}`],
    ['Hard cap', usd(o.estimate.default_cap_usd)],
  ]
  return (
    <div className={cn('flex flex-col gap-2.5 rounded-xl bg-(--glass-fill) px-4 py-3.5 transition-opacity', stale && 'opacity-60')} aria-busy={stale || undefined}>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-[12px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-fg-46">{k}</dt>
            <dd className="min-w-0 break-words text-fg tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      {o.notes.length > 0 && (
        <ul className="flex flex-col gap-1 text-[11.5px] leading-relaxed text-fg-46">
          {o.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

function RunView({ o, fit, type, onFit, onType, page, onPage }: { o: CheckOverview; fit: Fit | null; type: PropertyType | null; onFit: (f: Fit | null) => void; onType: (t: PropertyType | null) => void; page: number; onPage: (p: number) => void }) {
  const run = o.run!
  const p = runProgress(o.summary?.items, run.companies_total)
  const fits = fitRows(o.summary)
  const types = typeRows(o.summary)
  const filtered = Boolean(fit || type)
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <p className="flex flex-wrap gap-x-3 text-[11.5px] text-fg-46">
          <span className={run.status === 'running' ? 'text-lime' : run.status === 'failed' ? 'text-red' : 'text-fg-70'}>{run.status}</span>
          <span className="font-mono tabular-nums">
            {usd(run.spent_usd)} spent of {usd(run.max_usd)} cap{run.estimate_usd != null ? ` · estimate ${usd(run.estimate_usd)}` : ''}
          </span>
          {(o.summary?.items.error ?? 0) > 0 && <span className="text-amber">{fmt.format(o.summary!.items.error)} failed</span>}
        </p>
        <Bar value={p.done} total={p.total} label="Companies checked" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Breakdown title="By fit · companies · leads" rows={fits} active={fit} onPick={onFit} tone={(k) => FIT_TONE[k]} />
        <Breakdown title="By property type · companies · leads" rows={types} active={type} onPick={onType} />
      </div>

      {filtered && (
        <p className="flex flex-wrap items-center gap-2 text-[11.5px] text-fg-70">
          Showing {[fit ? FIT_LABEL[fit] : null, type ? TYPE_LABEL[type] : null].filter(Boolean).join(' · ')}
          <button type="button" className="text-fg-46 underline-offset-2 hover:text-fg hover:underline" onClick={() => (onFit(null), onType(null))}>
            Clear
          </button>
        </p>
      )}

      <Results rows={o.results} />

      {(page > 0 || o.results.length === PAGE) && (
        <div className="flex items-center gap-2">
          <Button size="xs" variant="ghost" disabled={page === 0} onClick={() => onPage(page - 1)}>
            Previous
          </Button>
          <span className="font-mono text-[11px] text-fg-46 tabular-nums">page {page + 1}</span>
          <Button size="xs" variant="ghost" disabled={o.results.length < PAGE} onClick={() => onPage(page + 1)}>
            Next
          </Button>
        </div>
      )}
    </div>
  )
}

function Results({ rows }: { rows: CheckOverview['results'] }) {
  if (!rows.length) return <p className="text-[12px] text-fg-46">No companies here yet.</p>
  return (
    <>
      {/* Phone: one card per company. */}
      <ul className="flex flex-col gap-2 sm:hidden" aria-label="Checked companies">
        {rows.map((r) => (
          <li key={r.company_key} className="flex flex-col gap-1 rounded-xl bg-white/[0.035] px-3 py-2.5 text-[12px]">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate font-medium text-fg">{r.company_name ?? r.company_key}</span>
              <span className={cn('shrink-0', r.icp_fit ? FIT_TONE[r.icp_fit] : 'text-fg-46')}>{r.icp_fit ? FIT_LABEL[r.icp_fit] : r.status}</span>
            </div>
            <p className="text-fg-46">
              {fmt.format(r.leads)} leads · {r.property_type ? TYPE_LABEL[r.property_type] : '—'} · {doorsText(r.doors)} doors{r.confidence ? ` · ${r.confidence}` : ''}
            </p>
            {r.what_it_does && <p className="text-fg-70">{r.what_it_does}</p>}
            {r.evidence_url && (
              <a href={r.evidence_url} target="_blank" rel="noopener noreferrer" className="truncate text-violet-soft hover:text-fg">
                source: {hostOf(r.evidence_url)}
              </a>
            )}
            {r.error && <p className="text-amber">{r.error}</p>}
          </li>
        ))}
      </ul>
      {/* Wider: a table that scrolls sideways inside its box. */}
      <div className="hidden max-h-[60vh] overflow-auto rounded-xl sm:block">
        <table aria-label="Checked companies" className="w-full min-w-[880px] text-left text-[12px]">
          <thead className="sticky top-0 z-10 bg-background text-fg-46">
            <tr>
              {['Company', 'Leads', 'Property type', 'Doors', 'Fit', 'Confidence', 'What it does', 'Evidence'].map((h) => (
                <th key={h} className="py-2 pr-3 font-normal whitespace-nowrap first:pl-3">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.company_key} className="border-t border-line align-top">
                <td className="max-w-48 py-2 pr-3 pl-3">
                  <span className="block truncate text-fg">{r.company_name ?? r.company_key}</span>
                  <span className="block truncate font-mono text-[10.5px] text-fg-46">{r.company_key}</span>
                </td>
                <td className="py-2 pr-3 font-mono text-fg tabular-nums">{fmt.format(r.leads)}</td>
                <td className="py-2 pr-3 whitespace-nowrap text-fg-70">{r.property_type ? TYPE_LABEL[r.property_type] : '—'}</td>
                <td className="py-2 pr-3 font-mono text-fg-70 tabular-nums" title={r.doors_evidence ?? undefined}>
                  {doorsText(r.doors)}
                </td>
                <td className={cn('py-2 pr-3 whitespace-nowrap', r.icp_fit ? FIT_TONE[r.icp_fit] : 'text-fg-46')}>{r.icp_fit ? FIT_LABEL[r.icp_fit] : r.status}</td>
                <td className="py-2 pr-3 font-mono text-fg-46">{r.confidence ?? '—'}</td>
                <td className="max-w-[22rem] py-2 pr-3 text-fg-70">
                  {r.what_it_does ?? '—'}
                  {r.error && <span className="block text-amber">{r.error}</span>}
                </td>
                <td className="max-w-[16rem] py-2 pr-3 text-fg-70">
                  {r.evidence_url && (
                    <a href={r.evidence_url} target="_blank" rel="noopener noreferrer" className="block truncate text-violet-soft hover:text-fg">
                      {hostOf(r.evidence_url)}
                    </a>
                  )}
                  {r.evidence && <span className="line-clamp-2">{r.evidence}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
