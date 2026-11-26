'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { toast } from 'sonner'
import { Check, ChevronDown, ChevronUp, Copy, ExternalLink, Mail, Phone, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SimpleSelect } from '@/components/ui/simple-select'
import { fetchJson } from '@/hooks/fetcher'
import { copyText, SIGNAL_LABEL, SKIP_LABEL, type HiringRow } from '@/lib/hiring/view'
import { cn } from '@/lib/utils'

type Lane = 'hiring' | 'new_manager' | 'expansion'

interface Payload {
  rows: HiringRow[]
  total: number
  config: { dry_run: boolean; lanes: Record<Lane, boolean>; monthly_cap_usd: number }
  month_to_date_usd: number
  last_runs: Partial<Record<Lane, { started_at: string; status: string; inserted: number | null }>>
}

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—')
const host = (url: string) => url.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')

const SIGNALS = [
  { value: 'all', label: 'All signals' },
  { value: 'hiring', label: 'Hiring' },
  { value: 'new_manager', label: 'New manager' },
  { value: 'expansion', label: 'Expansion' },
]
const TIERS = [
  { value: 'all', label: 'All tiers' },
  { value: 'coordinator', label: 'Coordinator' },
  { value: 'leadership', label: 'Leadership' },
]
const STATUSES = [
  { value: 'new', label: 'New' },
  { value: 'sent', label: 'Sent' },
  { value: 'skipped', label: 'Skipped' },
  { value: 'all', label: 'Any status' },
]

function Ext({ href, children, title }: { href: string | null; children: React.ReactNode; title?: string }) {
  if (!href) return null
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" title={title} className="inline-flex min-w-0 items-center gap-1 text-fg-70 underline-offset-2 hover:text-fg hover:underline">
      {children}
    </a>
  )
}

function TierBadge({ row }: { row: HiringRow }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      <span className="text-[12px] text-fg-70">{SIGNAL_LABEL[row.signal]}</span>
      {row.role_tier && (
        <span className={cn('rounded-md px-1.5 py-px text-[10.5px] font-medium', row.role_tier === 'coordinator' ? 'bg-cyan/12 text-cyan' : 'bg-white/[0.06] text-fg-70')}>
          {row.role_tier === 'coordinator' ? 'Coordinator' : 'Leadership'}
        </span>
      )}
    </span>
  )
}

function Row({ row, onDone }: { row: HiringRow; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const hasDraft = !!(row.draft_subject && row.draft_body)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(copyText(row))
      toast.success('Email copied', { description: 'Subject and body. Send it from your inbox.' })
    } catch {
      toast.error("Couldn't copy: select the text and copy it by hand.")
      setOpen(true)
    }
  }
  const decide = async (decision: 'sent' | 'skipped') => {
    setBusy(true)
    try {
      const res = await fetch(`/api/signals/hiring/${row.id}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision }),
      })
      if (res.ok) toast.success(decision === 'sent' ? 'Marked sent' : 'Skipped')
      else if (res.status === 409) toast.message('Already decided')
      else toast.error(`Couldn't save (HTTP ${res.status})`)
    } catch {
      toast.error("Couldn't save: network error")
    }
    setBusy(false)
    onDone()
  }

  return (
    <li className="flex flex-col gap-2 rounded-xl px-3 py-2.5 hover:bg-white/[0.04]">
      <div className="grid grid-cols-1 gap-x-4 gap-y-1.5 lg:grid-cols-[4.5rem_8rem_minmax(0,1.3fr)_minmax(0,1.1fr)_minmax(0,0.9fr)_minmax(0,1.6fr)_auto]">
        <span className="font-mono text-[12px] text-fg-46 tabular-nums">{day(row.posted_at ?? row.created_at)}</span>
        <TierBadge row={row} />
        <span className="min-w-0">
          <Ext href={row.source_url} title="Open the source">
            <span className="truncate text-[13.5px] text-fg">{row.role_title ?? row.headline ?? 'Signal'}</span>
            <ExternalLink className="size-3 shrink-0 text-fg-46" />
          </Ext>
          {row.signal === 'expansion' && row.headline && <span className="line-clamp-2 text-[11.5px] text-fg-46">{row.headline}</span>}
          {row.location && <span className="block truncate text-[11.5px] text-fg-46">{row.location}</span>}
        </span>
        <span className="flex min-w-0 flex-col gap-0.5 text-[12px]">
          <span className="truncate text-[13px] text-fg">{row.company_name ?? row.company_domain ?? '—'}</span>
          <span className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
            <Ext href={row.company_website}>{row.company_website ? host(row.company_website) : null}</Ext>
            <Ext href={row.company_linkedin}>LinkedIn</Ext>
            {row.company_phone && (
              <a href={`tel:${row.company_phone.replace(/[^\d+]/g, '')}`} className="inline-flex items-center gap-1 font-mono text-fg-70 hover:text-fg">
                <Phone className="size-3" />
                {row.company_phone}
              </a>
            )}
          </span>
        </span>
        <span className="flex min-w-0 flex-col gap-0.5 text-[12px]">
          {row.person_name ? (
            <Ext href={row.person_linkedin} title="LinkedIn profile">
              <span className="truncate text-[13px] text-fg">{row.person_name}</span>
            </Ext>
          ) : (
            !row.contact_name && <span className="text-fg-24">No contact</span>
          )}
          {row.person_name && !row.person_linkedin && <span className="truncate text-[13px] text-fg">{row.person_name}</span>}
          {row.person_title && <span className="line-clamp-2 text-[11.5px] text-fg-46">{row.person_title}</span>}
          {/* A decision-maker Blitz found for the company (when the row named nobody with a profile). */}
          {row.contact_name && row.contact_linkedin !== row.person_linkedin && (
            <>
              <Ext href={row.contact_linkedin ?? null} title="LinkedIn profile">
                <span className="truncate text-[13px] text-fg">{row.contact_name}</span>
              </Ext>
              {row.contact_title && <span className="line-clamp-2 text-[11.5px] text-fg-46">{row.contact_title}</span>}
            </>
          )}
          {row.contact_email && (
            <a href={`mailto:${row.contact_email}`} className="inline-flex min-w-0 items-center gap-1 font-mono text-fg-70 hover:text-fg" title="Work email (Blitz)">
              <Mail className="size-3 shrink-0" />
              <span className="truncate">{row.contact_email}</span>
            </a>
          )}
        </span>
        <span className="min-w-0 text-[12px]">
          {hasDraft ? (
            <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full min-w-0 flex-col items-start gap-0.5 text-left" aria-expanded={open}>
              <span className="flex w-full items-center gap-1.5">
                <span className="truncate font-medium text-fg">{row.draft_subject}</span>
                {row.draft_status === 'needs_edit' && <span className="shrink-0 rounded-md bg-amber/12 px-1.5 py-px text-[10.5px] text-amber">Needs edit</span>}
                {open ? <ChevronUp className="size-3.5 shrink-0 text-fg-46" /> : <ChevronDown className="size-3.5 shrink-0 text-fg-46" />}
              </span>
              {!open && <span className="line-clamp-2 text-fg-46">{row.draft_body}</span>}
            </button>
          ) : (
            <span className="text-fg-46">{row.draft_status === 'failed' ? 'Draft failed: write this one yourself.' : row.skip_reason ? (SKIP_LABEL[row.skip_reason] ?? row.skip_reason) : 'No draft'}</span>
          )}
        </span>
        <span className="flex items-start justify-end gap-1">
          {hasDraft && (
            <Button size="xs" variant="ghost" onClick={() => void copy()} title="Copy subject + body">
              <Copy /> Copy email
            </Button>
          )}
          {row.status === 'new' && !row.skip_reason ? (
            <>
              <Button size="xs" variant="secondary" disabled={busy} onClick={() => void decide('sent')} title="You sent it by hand">
                <Check /> Mark sent
              </Button>
              <Button size="xs" variant="ghost" disabled={busy} onClick={() => void decide('skipped')} title="Not this one">
                <X /> Skip
              </Button>
            </>
          ) : (
            <span className="px-2 text-[11.5px] text-fg-46">{row.status === 'sent' ? `Sent ${day(row.decided_at)}` : row.status === 'skipped' ? 'Skipped' : ''}</span>
          )}
        </span>
      </div>
      {open && hasDraft && (
        <div className="flex flex-col gap-2 rounded-xl bg-white/[0.03] p-3 lg:ml-[13.5rem]">
          <p className="text-[12px] text-fg-46">
            Subject: <span className="text-fg">{row.draft_subject}</span>
          </p>
          <pre className="font-sans text-[13px] leading-relaxed whitespace-pre-wrap text-fg">{row.draft_body}</pre>
          {row.draft_violations?.length ? (
            <ul className="flex flex-col gap-0.5 text-[11.5px] text-amber" aria-label="SOP violations">
              {row.draft_violations.map((v, i) => (
                <li key={i}>
                  {v.rule}: {v.message}
                </li>
              ))}
            </ul>
          ) : null}
          {row.pm_evidence && <p className="text-[11.5px] text-fg-46">PM check: {row.pm_evidence}</p>}
        </div>
      )}
    </li>
  )
}

/**
 * GTM-19 Hiring Ops Signal sheet: PM companies with a live signal (hiring,
 * a new ops leader, expansion news), each with a ready email from Frank to
 * copy and send by hand. Mark sent / Skip record the decision once. Nothing
 * here sends anything.
 */
export function HiringSheet() {
  const [signal, setSignal] = useState('all')
  const [tier, setTier] = useState('all')
  const [status, setStatus] = useState('new')
  const [skipped, setSkipped] = useState(false)
  const qs = new URLSearchParams({ signal, tier, status: skipped ? 'all' : status, ...(skipped ? { skipped: '1' } : {}) })
  const { data, error, mutate } = useSWR<Payload>(`/api/signals/hiring?${qs}`, fetchJson, { refreshInterval: 60_000 })

  return (
    <section aria-label="Hiring Ops Signal" className="flex flex-col gap-4 rounded-2xl bg-(--glass-fill) p-4 backdrop-blur-xl sm:p-5">
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="flex flex-wrap items-center gap-2" aria-label="Lanes">
          {(['hiring', 'new_manager', 'expansion'] as const).map((l) => {
            const on = data?.config.lanes[l] ?? false
            const last = data?.last_runs[l]
            return (
              <span key={l} className={cn('flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12px]', on ? 'bg-green/10 text-green' : 'bg-white/[0.04] text-fg-46')} title={last ? `Last run ${day(last.started_at)} · ${last.status}` : 'No run yet'}>
                <span className={cn('size-1.5 rounded-full', on ? 'bg-green' : 'bg-fg-24')} />
                {SIGNAL_LABEL[l]} {on ? 'on' : 'off'}
              </span>
            )
          })}
          {data?.config.dry_run && <span className="rounded-lg bg-amber/10 px-2 py-1 text-[12px] text-amber">Dry run: notices stay in Lume</span>}
        </div>
        {data && (
          <span className="font-mono text-[12px] text-fg-46 tabular-nums">
            ${data.month_to_date_usd.toFixed(2)} <span className="text-fg-24">/ ${data.config.monthly_cap_usd} this month</span>
          </span>
        )}
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <SimpleSelect size="sm" aria-label="Signal" value={signal} onValueChange={setSignal} options={SIGNALS} className="w-40" />
        <SimpleSelect size="sm" aria-label="Tier" value={tier} onValueChange={setTier} options={TIERS} className="w-36" />
        {!skipped && <SimpleSelect size="sm" aria-label="Status" value={status} onValueChange={setStatus} options={STATUSES} className="w-36" />}
        <Button size="sm" variant={skipped ? 'secondary' : 'ghost'} aria-pressed={skipped} onClick={() => setSkipped((s) => !s)} title="Rows the pipeline filtered out, with the reason">
          {skipped ? 'Showing filtered out' : 'Show filtered out'}
        </Button>
        {data && <span className="ml-auto text-[12px] text-fg-46">{data.total.toLocaleString('en-US')} rows</span>}
      </div>

      {error && !data && <p className="text-[12px] text-fg-46">Couldn&apos;t load the sheet.</p>}
      {!data && !error && <div className="h-40 animate-pulse rounded-2xl bg-white/[0.03]" aria-label="Loading" />}
      {data && data.rows.length === 0 && <p className="py-6 text-center text-[12.5px] text-fg-46">{skipped ? 'Nothing filtered out.' : 'No signals here yet. New ones land after each run.'}</p>}
      {data && data.rows.length > 0 && (
        <ul className="-mx-3 flex flex-col">
          {data.rows.map((r) => (
            <Row key={r.id} row={r} onDone={() => void mutate()} />
          ))}
        </ul>
      )}
    </section>
  )
}
