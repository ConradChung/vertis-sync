'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import useSWR from 'swr'
import { Check, ExternalLink, Search } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Surface } from '@/components/shell/Surface'
import { phoneHref } from '@/components/portal/format'
import { fetchJson } from '@/hooks/fetcher'
import { shortDate } from '@/lib/crm/pilot'
import {
  SIGNAL_SOURCES,
  SIGNAL_STATUSES,
  SOURCE_LABEL,
  TOUCH_CHANNELS,
  type SignalInbox,
  type SignalRow,
  type SignalSource,
  type SignalStatus,
  type TouchChannel,
} from '@/lib/signals/merge'
import { ownerDate } from '@/lib/time/owner'
import { sendJson } from '@/lib/validate/client'
import { cn } from '@/lib/utils'

const STATUS_LABEL: Record<SignalStatus, string> = { new: 'New', working: 'Working', replied: 'Replied', dropped: 'Dropped' }
const TOUCH_LABEL: Record<TouchChannel, string> = { email: 'Email', linkedin: 'LinkedIn', call: 'Call' }
const STATUS_OPTIONS = SIGNAL_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))

type StatusFilter = SignalStatus | 'all'
type Patch = { status?: SignalStatus; touch?: { channel: TouchChannel; done: boolean } }

export function inboxKey(source: SignalSource | 'all', status: StatusFilter, q: string): string {
  const p = new URLSearchParams()
  if (source !== 'all') p.set('source', source)
  if (status !== 'all') p.set('status', status)
  if (q) p.set('q', q)
  const qs = p.toString()
  return qs ? '/api/signals/inbox?' + qs : '/api/signals/inbox'
}

/**
 * The Signals inbox: one row per company, merged across hiring signals, post
 * comments, Reddit mentions and influencer reactions. Each row shows where
 * the signal came from, the newest one, a status and three touches (email,
 * LinkedIn, call). A touch is a tick the owner makes after doing it by hand;
 * nothing is sent from here. "Start deal" puts the account on the Pipeline
 * in Conversation.
 *
 * `fixedSource` pins the source filter (the /signals/hiring view);
 * `defaultSource` only starts it there (`/signals?source=`).
 */
export function SignalsInbox({ initial, fixedSource, defaultSource }: { initial?: SignalInbox; fixedSource?: SignalSource; defaultSource?: SignalSource }) {
  const [source, setSource] = useState<SignalSource | 'all'>(fixedSource ?? defaultSource ?? 'all')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [typed, setTyped] = useState('')
  const [q, setQ] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), 250)
    return () => clearTimeout(t)
  }, [typed])
  const key = inboxKey(source, status, q)
  // The server's rows are the unfiltered inbox: use them only for that key.
  const { data, error, mutate } = useSWR<SignalInbox>(key, fetchJson, {
    fallbackData: key === '/api/signals/inbox' ? initial : undefined,
    keepPreviousData: true,
    revalidateOnFocus: true,
  })
  // Every row with a save in flight stays disabled until its own save returns.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const hold = (key: string, on: boolean) =>
    setBusy((cur) => {
      const next = new Set(cur)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })

  async function patch(row: SignalRow, body: Patch) {
    hold(row.key, true)
    const a = await sendJson('/api/signals/accounts', { key: row.state_key, ...body }, { method: 'PATCH' })
    hold(row.key, false)
    if (a.status !== 200) toast.error('Could not save. Try again.')
    void mutate()
  }

  async function startDeal(row: SignalRow) {
    hold(row.key, true)
    const a = await sendJson<{ deal_id: string }>('/api/signals/accounts/deal', { key: row.state_key })
    hold(row.key, false)
    if ((a.status === 200 || a.status === 201) && a.body) toast(row.name + ' is in Conversation', { description: 'Open it from the row or the Pipeline.' })
    else toast.error('Could not start the deal. Try again.')
    void mutate()
  }

  const rows = data?.rows ?? []
  const counts = data?.counts
  const everything = counts ? counts.new + counts.working + counts.replied + counts.dropped : null

  return (
    <Surface className="gap-8">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div role="group" aria-label="Status" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
          {(['all', ...SIGNAL_STATUSES] as const).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={status === s}
              onClick={() => setStatus(s)}
              className={cn('outline-none hover:text-fg focus-visible:underline', status === s ? 'font-medium text-fg' : 'text-fg-46')}
            >
              {s === 'all' ? 'All' : STATUS_LABEL[s]}
              {counts && <span className="ml-1 font-mono text-[12px] text-fg-46 tabular-nums">{s === 'all' ? everything : counts[s]}</span>}
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          {!fixedSource && (
            <SimpleSelect
              aria-label="Source"
              size="sm"
              className="w-44"
              value={source}
              onValueChange={(v) => setSource((v || 'all') as SignalSource | 'all')}
              options={[{ value: 'all', label: 'All sources' }, ...SIGNAL_SOURCES.map((s) => ({ value: s, label: SOURCE_LABEL[s] }))]}
            />
          )}
          <label className="relative block">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-46" strokeWidth={1.75} aria-hidden />
            <input
              type="search"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Search company"
              aria-label="Search company"
              className="h-8 w-52 rounded-lg bg-secondary pr-3 pl-9 text-[13px] text-fg outline-none placeholder:text-fg-46 focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
        </div>
      </div>

      {data && data.failed.length > 0 && (
        <p role="status" className="text-[13px] text-fg-70">
          Could not load {data.failed.map((s) => SOURCE_LABEL[s].toLowerCase()).join(', ')} just now. The other sources are current.
        </p>
      )}
      {error && !data && <p className="text-[13px] text-fg-70">Signals could not load. Refresh to try again.</p>}
      {!error && !data && <p className="text-[13px] text-fg-46">Loading…</p>}
      {data && rows.length === 0 && <p className="text-[13px] text-fg-46">{everything === 0 ? 'No signal accounts yet.' : 'No accounts match.'}</p>}

      {rows.length > 0 && (
        <ul aria-label="Signal accounts" className="flex flex-col gap-8">
          {rows.map((r) => (
            <Row key={r.key} row={r} busy={busy.has(r.key)} onPatch={patch} onStartDeal={startDeal} />
          ))}
        </ul>
      )}
      {data && data.total > rows.length && (
        <p className="text-[12px] text-fg-46">
          Showing the newest {rows.length} of {data.total}. Search or filter to narrow it.
        </p>
      )}
    </Surface>
  )
}

function Row({ row: r, busy, onPatch, onStartDeal }: { row: SignalRow; busy: boolean; onPatch: (r: SignalRow, b: Patch) => void; onStartDeal: (r: SignalRow) => void }) {
  const tel = phoneHref(r.phone)
  const contact = r.contacts[0]
  return (
    <li data-key={r.key} className="grid gap-x-6 gap-y-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
      <div className="min-w-0">
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-[15px] font-medium text-fg">{r.name}</span>
          {r.domain && (
            <a href={'https://' + r.domain} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[13px] text-fg-46 hover:text-fg">
              {r.domain} <ExternalLink className="size-3" strokeWidth={1.75} aria-hidden />
            </a>
          )}
          {tel && (
            <a href={tel} className="font-mono text-[13px] text-fg-70 hover:text-fg">
              {r.phone}
            </a>
          )}
        </p>
        <p data-newest className="mt-1 line-clamp-2 text-[13px] text-fg-70">
          {r.newest.url && /^https?:\/\//i.test(r.newest.url) ? (
            <a href={r.newest.url} target="_blank" rel="noreferrer" className="hover:text-fg hover:underline">
              {r.newest.label}
            </a>
          ) : (
            r.newest.label
          )}
        </p>
        <p className="mt-1 flex flex-wrap gap-x-3 text-[12px] text-fg-46">
          <span data-sources>{r.sources.map((s) => SOURCE_LABEL[s]).join(' · ')}</span>
          {r.newest.at && <time dateTime={r.newest.at}>{shortDate(ownerDate(r.newest.at))}</time>}
          {r.count > 1 && <span>{r.count} signals</span>}
          {contact && <span className="truncate">{[contact.name, contact.title].filter(Boolean).join(', ')}</span>}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <SimpleSelect
          aria-label={'Status of ' + r.name}
          size="sm"
          className="w-28"
          value={r.status}
          disabled={busy}
          onValueChange={(v) => {
            if (v && v !== r.status) onPatch(r, { status: v as SignalStatus })
          }}
          options={STATUS_OPTIONS}
        />
        <div role="group" aria-label={'Touches for ' + r.name} className="flex items-center gap-2">
          {TOUCH_CHANNELS.map((c) => {
            const at = r.touches[c]
            return (
              <button
                key={c}
                type="button"
                aria-pressed={!!at}
                aria-label={TOUCH_LABEL[c] + (at ? ' done' : '')}
                disabled={busy}
                title={at ? TOUCH_LABEL[c] + ' done ' + shortDate(ownerDate(at)) : undefined}
                onClick={() => onPatch(r, { touch: { channel: c, done: !at } })}
                className={cn(
                  'inline-flex h-8 items-center gap-1 rounded-lg px-3 text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
                  at ? 'bg-foreground text-background' : 'bg-secondary text-fg-70 hover:text-fg'
                )}
              >
                {at && <Check className="size-3.5" strokeWidth={1.75} aria-hidden />}
                {TOUCH_LABEL[c]}
                {at && <span className="font-mono text-[11px] opacity-70">{shortDate(ownerDate(at))}</span>}
              </button>
            )
          })}
        </div>
        {r.deal_id ? (
          <Link href={'/crm?campaign=signals&deal=' + r.deal_id} className="inline-flex h-8 items-center px-1 text-[13px] text-fg hover:underline">
            Open deal
          </Link>
        ) : (
          <Button size="sm" variant="secondary" className="h-8 rounded-lg px-3" disabled={busy} onClick={() => onStartDeal(r)}>
            Start deal
          </Button>
        )}
      </div>
    </li>
  )
}
