'use client'

import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, ExternalLink, Loader2, RefreshCw } from 'lucide-react'

// Job Search panel — the dashboard mirror of the Telegram gates.
//
// Lists job_batches newest first with the same buttons the bot offers. Each
// button POSTs to /api/jobsearch/batches/[id]/action, which runs the identical
// conditional claim telegram-inbox runs, so a tap here and a tap in Telegram
// can never both win. Polls every 15 s while any batch is working.

const SHEET_ID = '1wjvpjyX2g7UUkjgeOXRtPEb7-s4MQfmPOgikalpthcs'
const JOBS_FINAL_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=935519386`
const GTM_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=1642822363`

const WORKING = new Set(['approved', 'resolving', 'ordered', 'delivered'])

interface Batch {
  id: string
  batch_date: string
  status: string
  review_status: string
  write_status: string
  watchdog_status: string
  companies_added: number
  companies_pulled: number
  companies_unresolved: number
  contacts_total: number
  contacts_kept: number
  apollo_url: string | null
  leadsfriday_order_id: number | null
  leadsfriday_status: string | null
  error: string | null
  created_at: string
  updated_at: string
}

interface Company {
  id: string
  company_name: string
  domain: string | null
  job_title: string | null
  job_link: string | null
  job_poster_name: string | null
  employees: number | null
  apollo_org_id: string | null
  resolve_status: string
  exclude_reason: string | null
}

interface Contact {
  id: string
  company_id: string | null
  company_name: string
  first_name: string | null
  last_name: string | null
  title: string | null
  email: string | null
  linkedin_url: string | null
  role: string
  rank: number
  seniority: string | null
}

interface Detail {
  companies: Company[]
  contacts: Contact[]
}

type Action = 'pull' | 'skip' | 'write' | 'discard' | 'resume' | 'abort'

const STATUS_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  awaiting_review: { bg: 'rgba(245,158,11,0.15)', fg: '#f59e0b', label: 'Awaiting review' },
  approved: { bg: 'rgba(94,106,210,0.15)', fg: '#8b93e8', label: 'Approved' },
  resolving: { bg: 'rgba(94,106,210,0.15)', fg: '#8b93e8', label: 'Resolving' },
  ordered: { bg: 'rgba(94,106,210,0.15)', fg: '#8b93e8', label: 'Ordered' },
  delivered: { bg: 'rgba(94,106,210,0.15)', fg: '#8b93e8', label: 'Delivered' },
  ranked: { bg: 'rgba(245,158,11,0.15)', fg: '#f59e0b', label: 'Ready to write' },
  written: { bg: 'rgba(34,197,94,0.15)', fg: '#22c55e', label: 'Written' },
  skipped: { bg: 'rgba(120,120,120,0.15)', fg: '#9ca3af', label: 'Skipped' },
  discarded: { bg: 'rgba(120,120,120,0.15)', fg: '#9ca3af', label: 'Discarded' },
  failed: { bg: 'rgba(239,68,68,0.15)', fg: '#ef4444', label: 'Failed' },
}

function StatusPill({ status, working }: { status: string; working: boolean }) {
  const s = STATUS_STYLE[status] ?? { bg: 'rgba(120,120,120,0.15)', fg: '#9ca3af', label: status }
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium whitespace-nowrap"
      style={{ background: s.bg, color: s.fg }}
    >
      {working && <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: s.fg }} />}
      {s.label}
    </span>
  )
}

function formatDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
}

function ActionButton({ label, onClick, busy, danger }: { label: string; onClick: () => void; busy: boolean; danger?: boolean }) {
  return (
    <button
      onClick={e => { e.stopPropagation(); onClick() }}
      disabled={busy}
      className="px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors disabled:opacity-50 whitespace-nowrap"
      style={{
        background: danger ? 'rgba(239,68,68,0.12)' : 'var(--surface-raised)',
        color: danger ? '#ef4444' : 'var(--text-primary)',
        border: '1px solid var(--border)',
      }}
    >
      {busy ? <Loader2 size={12} className="animate-spin inline" /> : label}
    </button>
  )
}

const ROLE_LABEL: Record<string, string> = {
  job_poster: 'Job poster',
  recruiter: 'Recruiter',
  sales_leader: 'Sales leader',
  founder: 'Founder',
  other: 'Other',
}

export default function JobSearchPanel() {
  const [batches, setBatches] = useState<Batch[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [details, setDetails] = useState<Record<string, Detail>>({})
  const [busy, setBusy] = useState<string | null>(null) // `${id}:${action}`
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/jobsearch/batches', { cache: 'no-store' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      setBatches(data.batches ?? [])
      setError('')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load batches')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadDetail = useCallback(async (id: string) => {
    const res = await fetch(`/api/jobsearch/batches?id=${id}`, { cache: 'no-store' })
    const data = await res.json()
    if (res.ok) setDetails(d => ({ ...d, [id]: { companies: data.companies ?? [], contacts: data.contacts ?? [] } }))
  }, [])

  useEffect(() => { load() }, [load])

  // Same cadence rule as EmailValidator: refresh only while something is working.
  useEffect(() => {
    const hasActive = batches.some(b => WORKING.has(b.status))
    if (!hasActive) return
    const id = setInterval(() => {
      load()
      if (expanded) loadDetail(expanded)
    }, 15_000)
    return () => clearInterval(id)
  }, [batches, expanded, load, loadDetail])

  async function act(batch: Batch, action: Action) {
    const key = `${batch.id}:${action}`
    setBusy(key)
    setNotice('')
    try {
      const res = await fetch(`/api/jobsearch/batches/${batch.id}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const data = await res.json()
      if (res.status === 409) setNotice('Already handled — probably from Telegram.')
      else if (!res.ok) setNotice(data.error ?? `HTTP ${res.status}`)
      else if (data.warning) setNotice(data.warning)
    } catch (e: unknown) {
      setNotice(e instanceof Error ? e.message : 'Request failed')
    } finally {
      setBusy(null)
      await load()
    }
  }

  function toggle(id: string) {
    if (expanded === id) { setExpanded(null); return }
    setExpanded(id)
    if (!details[id]) loadDetail(id)
  }

  const anyWorking = batches.some(b => WORKING.has(b.status))

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <div className="flex items-start justify-between mb-6 gap-4">
        <div>
          <h1 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>Job Search</h1>
          <p className="text-[13px] mt-1" style={{ color: 'var(--text-secondary)' }}>
            Weekly GTM-engineer scrape → review → Apollo + Leadsfriday → ranked contacts → <code>gtm</code> tab.
            Buttons here are the same as the Telegram ones; whichever is tapped first wins.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <a href={JOBS_FINAL_URL} target="_blank" rel="noreferrer" className="text-[12px] inline-flex items-center gap-1 hover:underline" style={{ color: 'var(--text-secondary)' }}>
            Jobs Final <ExternalLink size={12} />
          </a>
          <a href={GTM_URL} target="_blank" rel="noreferrer" className="text-[12px] inline-flex items-center gap-1 hover:underline" style={{ color: 'var(--text-secondary)' }}>
            gtm <ExternalLink size={12} />
          </a>
          <button onClick={load} className="p-1.5 rounded-md" style={{ color: 'var(--text-secondary)' }} title="Refresh">
            <RefreshCw size={14} className={anyWorking ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {notice && (
        <div className="mb-4 px-3 py-2 rounded-lg text-[12px]" style={{ background: 'rgba(245,158,11,0.12)', color: '#f59e0b' }}>
          {notice}
        </div>
      )}
      {error && (
        <div className="mb-4 px-3 py-2 rounded-lg text-[12px]" style={{ background: 'rgba(239,68,68,0.12)', color: '#ef4444' }}>
          {error}
        </div>
      )}

      <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border)', background: 'var(--surface)' }}>
        <table className="w-full text-[12.5px]">
          <thead>
            <tr style={{ color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border)' }} className="text-left text-[10.5px] uppercase tracking-wider">
              <th className="px-3 py-2.5 w-6" />
              <th className="px-3 py-2.5">Batch</th>
              <th className="px-3 py-2.5">Status</th>
              <th className="px-3 py-2.5 text-right">Added</th>
              <th className="px-3 py-2.5 text-right">Pulled</th>
              <th className="px-3 py-2.5 text-right">Unresolved</th>
              <th className="px-3 py-2.5 text-right">Kept</th>
              <th className="px-3 py-2.5">Leadsfriday</th>
              <th className="px-3 py-2.5 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={9} className="px-3 py-8 text-center" style={{ color: 'var(--text-tertiary)' }}>Loading…</td></tr>
            )}
            {!loading && batches.length === 0 && (
              <tr><td colSpan={9} className="px-3 py-8 text-center" style={{ color: 'var(--text-tertiary)' }}>
                No batches yet. The Monday scrape creates the first one.
              </td></tr>
            )}
            {batches.map(b => {
              const working = WORKING.has(b.status)
              const open = expanded === b.id
              const d = details[b.id]
              return (
                <BatchRows
                  key={b.id}
                  batch={b}
                  working={working}
                  open={open}
                  detail={d}
                  busy={busy}
                  onToggle={() => toggle(b.id)}
                  onAct={(a) => act(b, a)}
                />
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function BatchRows({
  batch: b, working, open, detail, busy, onToggle, onAct,
}: {
  batch: Batch
  working: boolean
  open: boolean
  detail: Detail | undefined
  busy: string | null
  onToggle: () => void
  onAct: (a: Action) => void
}) {
  const isBusy = (a: Action) => busy === `${b.id}:${a}`
  const canResume = working && b.watchdog_status === 'awaiting'

  return (
    <>
      <tr
        onClick={onToggle}
        className="cursor-pointer transition-colors hover:bg-[var(--surface-raised)]"
        style={{ borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
      >
        <td className="px-3 py-2.5" style={{ color: 'var(--text-tertiary)' }}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </td>
        <td className="px-3 py-2.5 whitespace-nowrap">
          <div className="font-medium">{formatDate(b.batch_date)}</div>
          {b.error && <div className="text-[11px] mt-0.5 max-w-xs truncate" style={{ color: '#ef4444' }} title={b.error}>{b.error}</div>}
        </td>
        <td className="px-3 py-2.5"><StatusPill status={b.status} working={working} /></td>
        <td className="px-3 py-2.5 text-right tabular-nums">{b.companies_added}</td>
        <td className="px-3 py-2.5 text-right tabular-nums">{b.companies_pulled}</td>
        <td className="px-3 py-2.5 text-right tabular-nums" style={{ color: b.companies_unresolved ? '#f59e0b' : undefined }}>{b.companies_unresolved}</td>
        <td className="px-3 py-2.5 text-right tabular-nums">
          {b.contacts_kept}{b.contacts_total ? <span style={{ color: 'var(--text-tertiary)' }}> / {b.contacts_total}</span> : null}
        </td>
        <td className="px-3 py-2.5 whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
          {b.leadsfriday_order_id ? `#${b.leadsfriday_order_id}` : '—'}
          {b.leadsfriday_status && <span className="ml-1.5 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{b.leadsfriday_status}</span>}
        </td>
        <td className="px-3 py-2.5">
          <div className="flex items-center justify-end gap-1.5">
            {b.status === 'awaiting_review' && (
              <>
                <ActionButton label="Reviewed, pull" onClick={() => onAct('pull')} busy={isBusy('pull')} />
                <ActionButton label="Skip" onClick={() => onAct('skip')} busy={isBusy('skip')} danger />
              </>
            )}
            {b.status === 'ranked' && (
              <>
                <ActionButton label="Write to gtm" onClick={() => onAct('write')} busy={isBusy('write')} />
                <ActionButton label="Discard" onClick={() => onAct('discard')} busy={isBusy('discard')} danger />
              </>
            )}
            {canResume && (
              <ActionButton label="Resume" onClick={() => onAct('resume')} busy={isBusy('resume')} />
            )}
            {working && !canResume && <Loader2 size={13} className="animate-spin" style={{ color: 'var(--text-tertiary)' }} />}
            {working && (
              <ActionButton label="Abort" onClick={() => onAct('abort')} busy={isBusy('abort')} danger />
            )}
          </div>
        </td>
      </tr>
      {open && (
        <tr style={{ borderBottom: '1px solid var(--border)' }}>
          <td colSpan={9} className="px-5 py-4" style={{ background: 'var(--bg)' }}>
            {!detail ? (
              <div className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>Loading…</div>
            ) : (
              <BatchDetail batch={b} detail={detail} />
            )}
          </td>
        </tr>
      )}
    </>
  )
}

function BatchDetail({ batch, detail }: { batch: Batch; detail: Detail }) {
  const byCompany = new Map<string, Contact[]>()
  for (const c of detail.contacts) {
    const key = c.company_id ?? c.company_name
    const g = byCompany.get(key) ?? []
    g.push(c)
    byCompany.set(key, g)
  }
  const companyName = (key: string) => detail.companies.find(c => c.id === key)?.company_name ?? key

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div>
        <p className="text-[10.5px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-tertiary)' }}>
          Companies ({detail.companies.length})
        </p>
        {detail.companies.length === 0 ? (
          <p className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>None yet — the gate phase fills this.</p>
        ) : (
          <ul className="space-y-1">
            {detail.companies.map(c => (
              <li key={c.id} className="flex items-start justify-between gap-3 text-[12px]">
                <div className="min-w-0">
                  <span style={{ color: 'var(--text-primary)' }}>{c.company_name}</span>
                  {c.domain && <span className="ml-1.5" style={{ color: 'var(--text-tertiary)' }}>{c.domain}</span>}
                  {c.job_title && <div className="truncate" style={{ color: 'var(--text-secondary)' }}>{c.job_title}</div>}
                </div>
                <span
                  className="shrink-0 text-[10.5px] px-1.5 py-0.5 rounded"
                  style={{
                    background: c.resolve_status === 'resolved' ? 'rgba(34,197,94,0.12)' : c.resolve_status === 'pending' ? 'rgba(94,106,210,0.12)' : 'rgba(120,120,120,0.12)',
                    color: c.resolve_status === 'resolved' ? '#22c55e' : c.resolve_status === 'pending' ? '#8b93e8' : '#9ca3af',
                  }}
                  title={c.apollo_org_id ?? undefined}
                >
                  {c.resolve_status}{c.exclude_reason ? ` · ${c.exclude_reason.replace(/_/g, ' ')}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
        {batch.apollo_url && (
          <a href={batch.apollo_url} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-[11.5px] hover:underline" style={{ color: 'var(--text-secondary)' }}>
            Open Apollo search <ExternalLink size={11} />
          </a>
        )}
      </div>

      <div>
        <p className="text-[10.5px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-tertiary)' }}>
          Kept contacts ({detail.contacts.length})
        </p>
        {detail.contacts.length === 0 ? (
          <p className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>None yet — the rank phase fills this.</p>
        ) : (
          <div className="space-y-3">
            {Array.from(byCompany.entries()).map(([key, list]) => (
              <div key={key}>
                <div className="text-[12px] font-medium mb-1" style={{ color: 'var(--text-primary)' }}>{companyName(key)}</div>
                <ul className="space-y-0.5">
                  {list.map(c => (
                    <li key={c.id} className="flex items-center gap-2 text-[12px]">
                      <span className="w-4 text-right tabular-nums" style={{ color: 'var(--text-tertiary)' }}>{c.rank}</span>
                      <span className="truncate" style={{ color: 'var(--text-primary)' }}>
                        {[c.first_name, c.last_name].filter(Boolean).join(' ') || '—'}
                      </span>
                      <span className="truncate" style={{ color: 'var(--text-secondary)' }}>{c.title}</span>
                      <span className="ml-auto shrink-0 text-[10.5px] px-1.5 rounded" style={{ background: 'var(--surface-raised)', color: 'var(--text-secondary)' }}>
                        {ROLE_LABEL[c.role] ?? c.role}
                      </span>
                      {c.email
                        ? <span className="shrink-0 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{c.email}</span>
                        : <span className="shrink-0 text-[11px]" style={{ color: '#f59e0b' }}>no email</span>}
                      {c.linkedin_url && (
                        <a href={c.linkedin_url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} style={{ color: 'var(--text-tertiary)' }}>
                          <ExternalLink size={11} />
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
