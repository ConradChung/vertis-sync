'use client'

import Link from 'next/link'
import { useEffect, useState, type ReactNode } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { ArrowDown, ArrowUp, ArrowUpRight, Check, ExternalLink, Search } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Surface } from '@/components/shell/Surface'
import { phoneHref } from '@/components/portal/format'
import { fetchJson } from '@/hooks/fetcher'
import { shortDate } from '@/lib/crm/pilot'
import {
  SIGNAL_STATUSES,
  MIN_DOORS_FILTER,
  SOURCE_LABEL,
  TOUCH_CHANNELS,
  formatDoors,
  type DoorCount,
  type LatestSignal,
  type SignalDetail,
  type SignalInbox,
  type SignalRow,
  type SignalSource,
  type SignalStatus,
  type TouchChannel,
} from '@/lib/signals/merge'
import { ownerDate } from '@/lib/time/owner'
import { sendJson } from '@/lib/validate/client'
import { cn } from '@/lib/utils'

const STATUS_LABEL: Record<SignalStatus, string> = {
  new: 'New',
  working: 'Working',
  replied: 'Replied',
  dropped: 'Dropped',
}
const TOUCH_LABEL: Record<TouchChannel, string> = {
  email: 'Email',
  linkedin: 'LinkedIn',
  call: 'Call',
}
const STATUS_OPTIONS = SIGNAL_STATUSES.map((s) => ({
  value: s,
  label: STATUS_LABEL[s],
}))

type StatusFilter = SignalStatus | 'all'
type Patch = {
  status?: SignalStatus
  touch?: { channel: TouchChannel; done: boolean }
}
/** Which columns the rows use: the All tab's, or one source tab's. */
type View = 'all' | 'comment' | 'reddit' | 'hiring'

/** Doors: `min` is the 500+ quick filter, `sort` the door-count order (highest first, or lowest first). */
export interface DoorOptions {
  min?: boolean
  sort?: 'desc' | 'asc' | null
}

export function inboxKey(source: SignalSource | 'all', status: StatusFilter, q: string, doors: DoorOptions = {}): string {
  const p = new URLSearchParams()
  if (source !== 'all') p.set('source', source)
  if (status !== 'all') p.set('status', status)
  if (q) p.set('q', q)
  if (doors.min) p.set('min_doors', String(MIN_DOORS_FILTER))
  if (doors.sort) p.set('sort', 'doors_' + doors.sort)
  const qs = p.toString()
  return qs ? '/api/signals/inbox?' + qs : '/api/signals/inbox'
}

const dealHref = (id: string) => '/crm?campaign=signals&deal=' + id
const day = (iso: string | null | undefined) => (iso ? shortDate(ownerDate(iso)) : null)
const isHttp = (u: string | null | undefined): u is string => !!u && /^https?:\/\//i.test(u)

/*
 * Column tracks per view, shared by the header row and every row (xl and up;
 * below that a row stacks). The last three are always Touches, Status and
 * Pipeline. Whole literal strings, so Tailwind sees them.
 */
const GRID: Record<View, string> = {
  all: 'xl:grid-cols-[minmax(0,1fr)_6rem_minmax(0,1.6fr)_15rem_7rem_9rem]',
  comment: 'xl:grid-cols-[minmax(0,0.9fr)_6rem_minmax(0,1.4fr)_minmax(0,1fr)_4.5rem_15rem_7rem_9rem]',
  reddit: 'xl:grid-cols-[minmax(0,0.9fr)_10rem_minmax(0,1fr)_minmax(0,1.3fr)_4.5rem_15rem_7rem_9rem]',
  hiring: 'xl:grid-cols-[minmax(0,1fr)_6rem_minmax(0,1.3fr)_minmax(0,0.9fr)_4.5rem_15rem_7rem_9rem]',
}
const HEADS: Record<View, string[]> = {
  all: ['Account', 'Doors', 'Latest signal'],
  comment: ['Person', 'Doors', 'Comment', 'Post', 'Date'],
  reddit: ['Author', 'Subreddit', 'Thread', 'Excerpt', 'Date'],
  hiring: ['Company', 'Doors', 'Signal', 'Contact', 'Date'],
}

/**
 * The Signals inbox: one row per company (a Reddit author is its own
 * account). The All tab merges every source; a source tab (`fixedSource`)
 * shows that source's newest signal per account in columns that fit it.
 *
 * Touches are a log, not actions: ticking Email, LinkedIn or Call records
 * that the owner did it by hand, with the date. Nothing is sent or dialled.
 * "Add to pipeline" creates the account's deal in Conversation on the
 * Pipeline, and the row then links to it.
 *
 * `defaultSource` only starts the All tab filtered (`/signals?source=influencer`).
 */
export function SignalsInbox({ initial, fixedSource, defaultSource }: { initial?: SignalInbox; fixedSource?: SignalSource; defaultSource?: SignalSource }) {
  const [source, setSource] = useState<SignalSource | 'all'>(fixedSource ?? defaultSource ?? 'all')
  const view: View = fixedSource === 'comment' || fixedSource === 'reddit' || fixedSource === 'hiring' ? fixedSource : 'all'
  const [status, setStatus] = useState<StatusFilter>('all')
  const [min500, setMin500] = useState(false)
  const [doorSort, setDoorSort] = useState<'desc' | 'asc' | null>(null)
  const [typed, setTyped] = useState('')
  const [q, setQ] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), 250)
    return () => clearTimeout(t)
  }, [typed])
  const hasDoors = view !== 'reddit'
  const key = inboxKey(source, status, q, hasDoors ? { min: min500, sort: doorSort } : {})
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
  // Deals made here, so the row links to its deal before the refetch lands.
  const [made, setMade] = useState<Record<string, string>>({})

  async function patch(row: SignalRow, body: Patch) {
    hold(row.key, true)
    const a = await sendJson('/api/signals/accounts', { key: row.state_key, ...body }, { method: 'PATCH' })
    hold(row.key, false)
    if (a.status !== 200) toast.error('Could not save. Try again.')
    void mutate()
  }

  async function addToPipeline(row: SignalRow) {
    hold(row.key, true)
    const a = await sendJson<{ deal_id: string }>('/api/signals/accounts/deal', { key: row.state_key })
    hold(row.key, false)
    const id = a.body?.deal_id
    if ((a.status === 200 || a.status === 201) && id) {
      setMade((m) => ({ ...m, [row.key]: id }))
      toast(row.name + ' is on the Pipeline', {
        action: {
          label: 'Open deal',
          onClick: () => window.location.assign(dealHref(id)),
        },
      })
    } else toast.error('Could not add it to the pipeline. Try again.')
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
        {hasDoors && (
          <button
            type="button"
            aria-pressed={min500}
            title="Only accounts with 500 or more doors"
            onClick={() => setMin500((v) => !v)}
            className={cn('text-[13px] outline-none hover:text-fg focus-visible:underline', min500 ? 'font-medium text-fg' : 'text-fg-46')}
          >
            {MIN_DOORS_FILTER}+
          </button>
        )}
        <div className="flex flex-wrap items-center gap-3 max-sm:w-full sm:ml-auto">
          {!fixedSource && source !== 'all' && (
            <button type="button" onClick={() => setSource('all')} className="text-[13px] text-fg-70 hover:text-fg">
              {SOURCE_LABEL[source]}s only · <span className="underline">show all</span>
            </button>
          )}
          <label className="relative block max-sm:w-full">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-46" strokeWidth={1.75} aria-hidden />
            <input
              type="search"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={view === 'reddit' ? 'Search author' : 'Search company or person'}
              aria-label="Search"
              className="h-8 w-full rounded-lg sm:w-60 bg-secondary pr-3 pl-9 text-[13px] text-fg outline-none placeholder:text-fg-46 focus-visible:ring-2 focus-visible:ring-ring"
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
        <div className="flex flex-col gap-4">
          <div data-heads className={cn('hidden gap-x-5 text-[12px] text-fg-46 xl:grid', GRID[view])}>
            {[...HEADS[view], 'Touches', 'Status', 'Pipeline'].map((h) =>
              h === 'Doors' ? (
                <button
                  key={h}
                  type="button"
                  aria-label={'Sort by doors' + (doorSort ? (doorSort === 'desc' ? ', highest first' : ', lowest first') : '')}
                  onClick={() => setDoorSort((d) => (d === null ? 'desc' : d === 'desc' ? 'asc' : null))}
                  className={cn('inline-flex items-center gap-1 text-left outline-none hover:text-fg focus-visible:underline', doorSort && 'text-fg')}
                >
                  Doors
                  {doorSort === 'desc' ? <ArrowDown className="size-3" strokeWidth={1.75} aria-hidden /> : doorSort === 'asc' ? <ArrowUp className="size-3" strokeWidth={1.75} aria-hidden /> : null}
                </button>
              ) : (
                <span key={h} className={h === 'Touches' ? 'pl-2' : undefined}>
                  {h}
                </span>
              )
            )}
          </div>
          <ul aria-label="Signal accounts" className="flex flex-col gap-7">
            {rows.map((r) => (
              <Row key={r.key} row={r} view={view} dealId={r.deal_id ?? made[r.key] ?? null} busy={busy.has(r.key)} onPatch={patch} onAdd={addToPipeline} />
            ))}
          </ul>
        </div>
      )}
      {data && data.total > rows.length && (
        <p className="text-[12px] text-fg-46">
          Showing the newest {rows.length} of {data.total}. Search or filter to narrow it.
        </p>
      )}
    </Surface>
  )
}

function Row({
  row: r,
  view,
  dealId,
  busy,
  onPatch,
  onAdd,
}: {
  row: SignalRow
  view: View
  dealId: string | null
  busy: boolean
  onPatch: (r: SignalRow, b: Patch) => void
  onAdd: (r: SignalRow) => void
}) {
  return (
    <li data-key={r.key} className={cn('grid gap-x-5 gap-y-2 xl:items-center', GRID[view])}>
      {cellsFor(view, r)}

      <div className="max-xl:mt-1">
        <p className="mb-1 text-[12px] text-fg-46 xl:hidden">Touches</p>
        <div role="group" aria-label={'Touches for ' + r.name} className="flex items-start gap-1">
          {TOUCH_CHANNELS.map((c) => (
            <Touch key={c} label={TOUCH_LABEL[c]} at={r.touches[c]} disabled={busy} onToggle={(done) => onPatch(r, { touch: { channel: c, done } })} />
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 xl:contents">
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
        <div>
          {dealId ? (
            <Link href={dealHref(dealId)} className="inline-flex h-8 items-center gap-1.5 text-[13px] text-fg hover:underline">
              Open deal <ArrowUpRight className="size-3.5" strokeWidth={1.75} aria-hidden />
            </Link>
          ) : (
            <Button size="sm" variant="secondary" className="h-8 rounded-lg px-3" disabled={busy} onClick={() => onAdd(r)}>
              Add to pipeline
            </Button>
          )}
        </div>
      </div>
    </li>
  )
}

/** One touch in the log: a tick box, the channel, and the date it was ticked (— until then). */
function Touch({ label, at, disabled, onToggle }: { label: string; at: string | null; disabled: boolean; onToggle: (done: boolean) => void }) {
  const when = day(at)
  return (
    <button
      type="button"
      aria-pressed={!!at}
      aria-label={at ? `${label} done ${when}` : label}
      disabled={disabled}
      onClick={() => onToggle(!at)}
      className="flex w-[76px] flex-col items-start gap-0.5 rounded-lg px-2 py-1 text-left outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
    >
      <span className={cn('flex items-center gap-1.5 text-[13px]', at ? 'text-fg' : 'text-fg-70')}>
        <span aria-hidden className={cn('grid size-3.5 shrink-0 place-items-center rounded-[4px] border', at ? 'border-transparent bg-foreground text-background' : 'border-(--line)')}>
          {at && <Check className="size-2.5" strokeWidth={2.25} />}
        </span>
        {label}
      </span>
      <span className="pl-5 font-mono text-[11px] text-fg-46 tabular-nums">{when ?? '—'}</span>
    </button>
  )
}

// ── cells ──────────────────────────────────────────────────────────────────

function Ext({ href, className, children }: { href: string | null | undefined; className?: string; children: ReactNode }) {
  if (!isHttp(href)) return <span className={className}>{children}</span>
  return (
    <a href={href} target="_blank" rel="noreferrer" className={cn('hover:text-fg hover:underline', className)}>
      {children}
    </a>
  )
}

/**
 * A LinkedIn person the ICP gate held: no unit count was found, so no Slack
 * card. Typing the count releases them (500+ goes on to the card, under 500 is skipped).
 */
function HeldUnits({ id, name }: { id: number; name: string | null }) {
  const { mutate } = useSWRConfig()
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const units = /^\d{1,7}$/.test(value.trim()) ? Number(value.trim()) : null
  async function save() {
    if (units === null) return
    setSaving(true)
    const a = await sendJson<{ outcome: 'continue' | 'skip'; min_units: number }>(`/api/signals/people/${id}/units`, { units })
    setSaving(false)
    if (a.status === 200 && a.body) {
      toast(a.body.outcome === 'continue' ? `${name ?? 'Released'}: on to the Slack card` : `${name ?? 'Skipped'}: under ${a.body.min_units} units, skipped`)
      void mutate((k) => typeof k === 'string' && k.startsWith('/api/signals/inbox'))
    } else toast.error(a.status === 409 ? 'Already moved on. Refresh.' : 'Could not save. Try again.')
  }
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      {name && <span className="w-full truncate text-[12px] text-fg-46">{name}</span>}
      <input
        inputMode="numeric"
        aria-label={'Unit count for ' + (name ?? 'this person')}
        placeholder="Units"
        value={value}
        disabled={saving}
        onChange={(e) => setValue(e.target.value)}
        className="h-7 w-20 rounded-md bg-secondary px-2 font-mono text-[12px] text-fg tabular-nums outline-none placeholder:text-fg-46 focus-visible:ring-2 focus-visible:ring-ring"
      />
      <Button type="submit" size="sm" variant="secondary" className="h-7 rounded-md px-2.5 text-[12px]" disabled={saving || units === null}>
        Save
      </Button>
    </form>
  )
}

/** "1,200 doors" tooltip: where the number came from and how sure that source was (when it says). */
const doorsTitle = (d: DoorCount) => {
  const bits = [d.source ? 'Source: ' + d.source.replace(/_/g, ' ') : null, d.confidence ? 'Confidence: ' + d.confidence : null].filter(Boolean)
  return bits.length ? bits.join(' · ') : undefined
}

/**
 * The Doors column: the account's count from its newest signal that has one,
 * or a muted Unknown. A LinkedIn person the ICP gate held is released from
 * here by typing their count. Hiring rows carry no count at all, so an
 * account with only hiring signals shows a dash.
 */
function DoorsCell({ r }: { r: SignalRow }) {
  const held = r.held ?? []
  const hiringOnly = r.sources.length > 0 && r.sources.every((s) => s === 'hiring')
  return (
    <div data-doors className="min-w-0">
      <p className="mb-1 text-[12px] text-fg-46 xl:hidden">Doors</p>
      {r.doors ? (
        <span title={doorsTitle(r.doors)} className="font-mono text-[13px] text-fg tabular-nums">
          {formatDoors(r.doors.count)}
        </span>
      ) : hiringOnly && held.length === 0 ? (
        <Muted>—</Muted>
      ) : (
        <Muted>Unknown</Muted>
      )}
      {held.length > 0 && (
        <div className="mt-2 flex flex-col gap-2">
          {held.map((h) => (
            <HeldUnits key={h.id} id={h.id} name={h.name} />
          ))}
        </div>
      )}
    </div>
  )
}

const Muted = ({ children }: { children: ReactNode }) => <span className="text-[13px] text-fg-46">{children}</span>

function DateCell({ at }: { at: string | null | undefined }) {
  const d = day(at)
  return d && at ? (
    <time dateTime={at} className="font-mono text-[12px] text-fg-46 tabular-nums">
      {d}
    </time>
  ) : (
    <Muted>—</Muted>
  )
}

function CompanyCell({ r }: { r: SignalRow }) {
  const tel = phoneHref(r.phone)
  return (
    <div className="min-w-0">
      <p className="truncate text-[14px] font-medium text-fg">{r.name}</p>
      {(r.domain || tel) && (
        <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[13px] text-fg-46">
          {r.domain && (
            <a href={'https://' + r.domain} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-fg">
              {r.domain} <ExternalLink className="size-3" strokeWidth={1.75} aria-hidden />
            </a>
          )}
          {tel && (
            <a href={tel} className="font-mono text-[12px] text-fg-70 hover:text-fg">
              {r.phone}
            </a>
          )}
        </p>
      )}
    </div>
  )
}

function detailOf<S extends SignalDetail['source']>(l: LatestSignal | undefined, s: S): Extract<SignalDetail, { source: S }> | null {
  return l?.detail?.source === s ? (l.detail as Extract<SignalDetail, { source: S }>) : null
}

function cellsFor(view: View, r: SignalRow): ReactNode {
  if (view === 'comment') {
    const l = r.latest.comment
    const d = detailOf(l, 'comment')
    return (
      <>
        <div className="min-w-0">
          <p className="truncate text-[14px] font-medium text-fg">
            <Ext href={l?.linkedin}>{l?.person ?? r.contacts[0]?.name ?? r.name}</Ext>
          </p>
          <p className="mt-0.5 truncate text-[13px] text-fg-46">{[l?.person_title, r.name !== l?.person ? r.name : null].filter(Boolean).join(' · ')}</p>
        </div>
        <DoorsCell r={r} />
        <p className="line-clamp-3 text-[13px] leading-snug text-fg-70">
          {d?.reaction ? <Muted>Reacted, no comment</Muted> : d?.comment ? <Ext href={l?.url}>“{d.comment}”</Ext> : <Ext href={l?.url}>{l?.label ?? r.newest.label}</Ext>}
        </p>
        <p className="line-clamp-2 text-[13px] leading-snug text-fg-70">
          {d?.post_excerpt ? <Ext href={d.post_url}>{d.post_excerpt}</Ext> : d?.post_url ? <Ext href={d.post_url}>Watched post</Ext> : <Muted>—</Muted>}
        </p>
        <DateCell at={l?.at ?? r.newest.at} />
      </>
    )
  }
  if (view === 'reddit') {
    const l = r.latest.reddit
    const d = detailOf(l, 'reddit')
    const author = d?.author?.replace(/^u\//, '')
    return (
      <>
        <p className="truncate text-[14px] font-medium text-fg">
          <Ext href={author ? 'https://www.reddit.com/user/' + encodeURIComponent(author) : null}>{author ? 'u/' + author : r.name}</Ext>
        </p>
        <p className="truncate text-[13px] text-fg-70">{d?.subreddit ? <Ext href={'https://www.reddit.com/r/' + encodeURIComponent(d.subreddit)}>r/{d.subreddit}</Ext> : <Muted>—</Muted>}</p>
        <p className="line-clamp-2 text-[13px] leading-snug text-fg">
          <Ext href={l?.url}>{d?.thread ?? l?.label ?? r.newest.label}</Ext>
        </p>
        <p className="line-clamp-3 text-[13px] leading-snug text-fg-70">{d?.excerpt ?? <Muted>—</Muted>}</p>
        <DateCell at={l?.at ?? r.newest.at} />
      </>
    )
  }
  if (view === 'hiring') {
    const l = r.latest.hiring
    const d = detailOf(l, 'hiring')
    const contact = r.contacts[0]
    return (
      <>
        <CompanyCell r={r} />
        <DoorsCell r={r} />
        <div className="min-w-0">
          <p className="line-clamp-2 text-[13px] leading-snug text-fg">
            <Ext href={l?.url}>{d?.role ?? l?.label ?? r.newest.label}</Ext>
          </p>
          {d && <p className="mt-0.5 text-[12px] text-fg-46">{d.signal}</p>}
        </div>
        <div className="min-w-0">
          {contact ? (
            <>
              <p className="truncate text-[13px] text-fg">
                <Ext href={contact.linkedin}>{contact.name}</Ext>
              </p>
              {contact.title && <p className="truncate text-[12px] text-fg-46">{contact.title}</p>}
            </>
          ) : (
            <Muted>—</Muted>
          )}
        </div>
        <DateCell at={l?.at ?? r.newest.at} />
      </>
    )
  }
  const contact = r.contacts[0]
  return (
    <>
      <div className="min-w-0">
        <CompanyCell r={r} />
        {contact && <p className="mt-0.5 truncate text-[12px] text-fg-46">{[contact.name, contact.title].filter(Boolean).join(', ')}</p>}
      </div>
      <DoorsCell r={r} />
      <div className="min-w-0">
        <p data-newest className="line-clamp-2 text-[13px] leading-snug text-fg-70">
          {isHttp(r.newest.url) ? (
            <a href={r.newest.url} target="_blank" rel="noreferrer" className="hover:text-fg hover:underline">
              {r.newest.label}
            </a>
          ) : (
            r.newest.label
          )}
        </p>
        <p className="mt-1 flex flex-wrap gap-x-3 text-[12px] text-fg-46">
          <span data-sources>{r.sources.map((s) => SOURCE_LABEL[s]).join(' · ')}</span>
          {r.newest.at && (
            <time dateTime={r.newest.at} className="font-mono tabular-nums">
              {day(r.newest.at)}
            </time>
          )}
          {r.count > 1 && <span>{r.count} signals</span>}
        </p>
      </div>
    </>
  )
}
