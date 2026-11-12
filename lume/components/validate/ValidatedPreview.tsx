'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { toast } from 'sonner'
import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, Download, Eye, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { ShimmerBar } from '@/components/overview/parts'
import { ExpandButton, SheetOverlay, scrollBoxClass, useSheetExpand } from '@/components/leads/SheetFrame'
import { RowEditor } from '@/components/validate/RowTable'
import { fetchJson } from '@/hooks/fetcher'
import { sendJson } from '@/lib/validate/client'
import { DISPLAY_NAME_MAX, PREVIEW_PAGE_SIZE, type PreviewFilter, type PreviewPage } from '@/lib/validate/preview'
import { cn } from '@/lib/utils'

const fmt = new Intl.NumberFormat('en-US')

export const previewRowsKey = (id: string, page: number, status: PreviewFilter, q: string) =>
  `/api/validation-jobs/${id}/rows?page=${page}&status=${status}${q ? `&q=${encodeURIComponent(q)}` : ''}`

/** Every SWR key that shows a job's name (after a rename). */
const showsJobName = (id: string) => (key: unknown) =>
  typeof key === 'string' &&
  (key.startsWith(`/api/validation-jobs/${id}`) ||
    key.startsWith('/api/validation-jobs?') ||
    key.startsWith('/api/validation-jobs/runs') ||
    key.startsWith(`/api/jobs/${id}`) ||
    key === '/api/jobs' ||
    key.startsWith('/api/validation/history') ||
    key.startsWith('/api/progress') ||
    key.startsWith('/api/gates'))

const FILTERS: { key: PreviewFilter; label: string; tone: string }[] = [
  { key: 'valid', label: 'Valid', tone: 'text-green' },
  { key: 'invalid', label: 'Invalid', tone: 'text-red' },
  { key: 'error', label: 'Error', tone: 'text-amber' },
  { key: 'all', label: 'All', tone: 'text-fg' },
]

const STATUS_TONE: Record<string, string> = {
  valid: 'text-green',
  invalid: 'text-red',
  error: 'text-amber',
  no_email: 'text-fg-46',
  pending: 'text-cyan',
}

/**
 * The job's name, renamable in place: click → input; Enter saves, Escape
 * cancels; an empty name goes back to the filename.
 */
export function RenamableName({ jobId, name, className }: { jobId: string; name: string; className?: string }) {
  const { mutate } = useSWRConfig()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (!editing) setDraft(name)
  }, [name, editing])

  const save = async () => {
    const next = draft.replace(/\s+/g, ' ').trim()
    if (next === name) return setEditing(false)
    if (next.length > DISPLAY_NAME_MAX) return void toast.error(`Keep it under ${DISPLAY_NAME_MAX} characters`)
    setSaving(true)
    const r = await sendJson(`/api/validation-jobs/${jobId}`, { display_name: next || null }, { method: 'PATCH' })
    setSaving(false)
    if (r.status === 200) {
      setEditing(false)
      toast.success(next ? `Renamed to ${next}` : 'Name reset')
      void mutate(showsJobName(jobId))
    } else toast.error("Couldn't rename the list")
  }

  if (editing) {
    return (
      <Input
        autoFocus
        aria-label="List name"
        value={draft}
        maxLength={DISPLAY_NAME_MAX}
        disabled={saving}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            e.preventDefault()
            void save()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setEditing(false)
          }
        }}
        onClick={(e) => e.stopPropagation()}
        onBlur={() => !saving && setEditing(false)}
        className="h-7 w-full max-w-sm text-[13px]"
      />
    )
  }
  return (
    <button
      type="button"
      title="Rename"
      aria-label={`Rename ${name}`}
      onClick={(e) => {
        e.stopPropagation()
        setEditing(true)
      }}
      className={cn('group/name inline-flex max-w-full min-w-0 items-center gap-1.5 truncate text-left hover:text-fg', className)}
    >
      <span className="truncate">{name}</span>
      <Pencil className="size-3 shrink-0 text-fg-24 opacity-0 transition-opacity group-hover/name:opacity-100 group-focus-visible/name:opacity-100" aria-hidden />
    </button>
  )
}

function Pager({ page, pages, total, onPage }: { page: number; pages: number; total: number; onPage: (p: number) => void }) {
  const from = total ? page * PREVIEW_PAGE_SIZE + 1 : 0
  const to = Math.min(total, (page + 1) * PREVIEW_PAGE_SIZE)
  const btn = (label: string, Icon: typeof ChevronLeft, target: number, disabled: boolean) => (
    <Button variant="ghost" size="icon-sm" aria-label={label} title={label} disabled={disabled} onClick={() => onPage(target)}>
      <Icon className="size-4" />
    </Button>
  )
  return (
    <div className="flex items-center justify-between gap-2 px-4 py-1.5 text-[12px] text-fg-46">
      <span className="tabular-nums">
        {total ? `Rows ${fmt.format(from)}–${fmt.format(to)} of ${fmt.format(total)} · page ${fmt.format(page + 1)} of ${fmt.format(pages)}` : 'No rows'}
      </span>
      <span className="flex items-center gap-0.5">
        {btn('First page', ChevronFirst, 0, page === 0)}
        {btn('Previous page', ChevronLeft, page - 1, page === 0)}
        {btn('Next page', ChevronRight, page + 1, page + 1 >= pages)}
        {btn('Last page', ChevronLast, pages - 1, page + 1 >= pages)}
      </span>
    </div>
  )
}

/** Debounced value (search box → query). */
function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

export interface LeadsPreviewProps {
  jobId: string
  /** Inline panel (Progress gate detail) expands over the page; in a dialog Expand fills the screen. */
  variant?: 'panel' | 'dialog'
  /** Bumped by the `E` hotkey: open the editor on the first pending row (finder prompt only). */
  editRequest?: number
  /** Dialog only: Expand state is owned by the dialog. */
  expanded?: boolean
  onToggleExpanded?: () => void
  /** Shown before the toolbar (the panel's title). */
  heading?: ReactNode
}

/**
 * One validation job's leads: the original CSV columns in their order, then
 * Status (MailTester reason on hover), then enrichment columns. Valid by
 * default (All when nothing is valid yet), 100 per page, search, CSV download.
 */
export function LeadsPreview({ jobId, variant = 'panel', editRequest = 0, expanded: ctlExpanded, onToggleExpanded, heading }: LeadsPreviewProps) {
  const own = useSheetExpand()
  const expanded = variant === 'dialog' ? !!ctlExpanded : own.expanded
  const toggle = variant === 'dialog' ? (onToggleExpanded ?? (() => {})) : own.toggle
  const [filter, setFilter] = useState<PreviewFilter>('valid')
  const picked = useRef(false)
  const [page, setPage] = useState(0)
  const [qInput, setQInput] = useState('')
  const q = useDebounced(qInput.trim())
  const [editing, setEditing] = useState<string | null>(null)
  const lastRequest = useRef(editRequest)
  const { data, error, mutate } = useSWR<PreviewPage>(previewRowsKey(jobId, page, filter, q), fetchJson, { keepPreviousData: true })

  useEffect(() => {
    setPage(0)
    setEditing(null)
    setFilter('valid')
    picked.current = false
  }, [jobId])
  useEffect(() => setPage(0), [q])

  // Nothing valid yet (a job still at the finder prompt or validating): show every row.
  useEffect(() => {
    if (!picked.current && data && data.job.id === jobId && filter === 'valid' && data.counts.valid === 0 && data.counts.all > 0) setFilter('all')
  }, [data, filter, jobId])

  useEffect(() => {
    if (editRequest === lastRequest.current) return
    lastRequest.current = editRequest
    if (!data) return
    if (!data.editable) return void toast.info('Editing is off for this job', { description: data.edit_block_reason ?? undefined })
    const first = data.rows.find((r) => r.status === 'pending')
    if (first) setEditing(first.id)
    else toast.info('No pending rows on this page', { description: 'Only rows the validator has not reached can be edited.' })
  }, [editRequest, data])

  const pick = (f: PreviewFilter) => {
    picked.current = true
    setFilter(f)
    setPage(0)
  }

  const total = data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / PREVIEW_PAGE_SIZE))
  const cols = data?.columns
  const colCount = cols ? cols.original.length + cols.enrichment.length + 2 + (data?.editable ? 1 : 0) : 1

  const body = (
    <>
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
        {heading}
        <div role="group" aria-label="Filter by status" className="flex max-w-full items-center gap-0.5 overflow-x-auto whitespace-nowrap rounded-lg bg-white/4 p-0.5 [scrollbar-width:none]">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={filter === f.key}
              onClick={() => pick(f.key)}
              className={cn(
                'rounded-md px-2.5 py-1 text-[12px] transition-colors',
                filter === f.key ? 'bg-white/10 text-fg' : 'text-fg-46 hover:text-fg'
              )}
            >
              {f.label}
              <span className={cn('ml-1.5 font-mono tabular-nums', filter === f.key ? f.tone : 'text-fg-24')}>{data ? fmt.format(data.counts[f.key]) : '·'}</span>
            </button>
          ))}
        </div>
        <Input
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          placeholder="Search email, name, company…"
          aria-label="Search leads"
          className="h-8 w-56 max-w-full"
        />
        <div className="flex-1" />
        <a
          href={`/api/validation-jobs/${jobId}/export?status=valid`}
          className="inline-flex items-center gap-1 text-[12px] text-fg-70 hover:text-fg"
          download
        >
          <Download className="size-3.5" aria-hidden /> Valid CSV
        </a>
        <a
          href={`/api/validation-jobs/${jobId}/export?status=all`}
          className="inline-flex items-center gap-1 text-[12px] text-fg-70 hover:text-fg"
          download
        >
          <Download className="size-3.5" aria-hidden /> All CSV
        </a>
        <ExpandButton expanded={expanded} onClick={toggle} />
      </div>
      {data?.editable && <p className="px-4 pb-1 text-[11px] text-fg-46">Rows the validator has not reached can be edited (pencil, or E).</p>}
      <Pager page={page} pages={pages} total={total} onPage={setPage} />
      <div
        className={cn(scrollBoxClass(expanded), variant === 'dialog' && !expanded && 'max-h-none min-h-0 flex-1', 'outline-none focus-visible:ring-2 focus-visible:ring-ring')}
        role="region"
        aria-label="Leads table"
        tabIndex={0}
        onKeyDown={(e) => {
          if ((e.target as HTMLElement).tagName === 'INPUT') return
          if (e.key === 'ArrowLeft' && page > 0) setPage(page - 1)
          if (e.key === 'ArrowRight' && page + 1 < pages) setPage(page + 1)
        }}
      >
        {!data && error ? (
          <p className="flex items-center gap-3 px-4 py-4 text-[12px] text-fg-70" role="alert">
            Couldn&apos;t load the leads.
            <button type="button" className="text-violet-soft hover:text-fg" onClick={() => void mutate()}>
              Retry
            </button>
          </p>
        ) : !data || !cols ? (
          <div className="flex flex-col gap-2 px-4 py-3" aria-busy="true">
            {[0, 1, 2, 3].map((i) => (
              <ShimmerBar key={i} className="h-4 w-full" />
            ))}
          </div>
        ) : data.rows.length === 0 ? (
          <p className="px-4 py-6 text-[13px] text-fg-46">{q ? `No ${filter === 'all' ? '' : `${filter} `}leads match “${q}”.` : `No ${filter === 'all' ? '' : `${filter} `}leads in this list.`}</p>
        ) : (
          <table aria-label="Leads" className="w-full min-w-max border-collapse text-left text-[12px]">
            <thead className="sticky top-0 z-10 bg-background text-[11px] text-fg-46">
              <tr>
                <th scope="col" className="px-3 py-2 pl-4 font-normal">
                  #
                </th>
                {cols.original.map((c) => (
                  <th key={`o:${c}`} scope="col" className="px-3 py-2 font-normal whitespace-nowrap">
                    {c}
                  </th>
                ))}
                <th scope="col" className="px-3 py-2 font-normal">
                  Status
                </th>
                {cols.enrichment.map((c) => (
                  <th key={`e:${c.key}`} scope="col" className="px-3 py-2 font-normal whitespace-nowrap">
                    {c.label}
                  </th>
                ))}
                {data.editable && (
                  <th scope="col" className="px-3 py-2 pr-4">
                    <span className="sr-only">Edit</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) =>
                editing === r.id && r.edit ? (
                  <RowEditor
                    key={r.id}
                    jobId={jobId}
                    row={r.edit}
                    colSpan={colCount}
                    onDone={() => {
                      setEditing(null)
                      void mutate()
                    }}
                  />
                ) : (
                  <tr key={r.id} className="text-fg-70 hover:bg-white/3">
                    <td className="px-3 py-2 pl-4 font-mono text-fg-24 tabular-nums">{r.row_index}</td>
                    {r.cells.map((v, i) => {
                      const cleaned = i === data.email_company_col && r.company_original !== undefined
                      return (
                        <td
                          key={i}
                          className="max-w-[240px] truncate px-3 py-2"
                          title={cleaned ? `Sent as: ${v ?? '—'}\nIn the CSV: ${r.company_original ?? '—'}` : (v ?? undefined)}
                        >
                          {v ?? <span className="text-fg-24">—</span>}
                        </td>
                      )
                    })}
                    <td className="px-3 py-2 whitespace-nowrap" title={r.reason ?? undefined}>
                      <span className={cn('font-medium', STATUS_TONE[r.status] ?? 'text-fg-46')}>{r.status_label}</span>
                      {r.reason && r.reason !== 'Accepted' && <span className="ml-1.5 text-fg-46">{r.reason}</span>}
                    </td>
                    {r.enrichment.map((v, i) => (
                      <td key={`e${i}`} className="max-w-[240px] truncate px-3 py-2" title={v ?? undefined}>
                        {v ?? <span className="text-fg-24">—</span>}
                      </td>
                    ))}
                    {data.editable && (
                      <td className="px-3 py-2 pr-4 text-right">
                        {r.status === 'pending' && r.edit && (
                          <Button size="icon-xs" variant="ghost" aria-label={`Edit row ${r.row_index}`} onClick={() => setEditing(r.id)}>
                            <Pencil />
                          </Button>
                        )}
                      </td>
                    )}
                  </tr>
                )
              )}
            </tbody>
          </table>
        )}
      </div>
      {total > PREVIEW_PAGE_SIZE && <Pager page={page} pages={pages} total={total} onPage={setPage} />}
    </>
  )

  if (variant === 'dialog') return <div className="flex min-h-0 flex-1 flex-col">{body}</div>
  return (
    <section className="overflow-hidden rounded-panel bg-white/4" aria-label="Leads in this job">
      <SheetOverlay expanded={expanded}>{body}</SheetOverlay>
    </section>
  )
}

/** The preview as a large dialog, titled by the list's (renamable) name. */
export function ValidatedPreviewDialog({ jobId, name, open, onOpenChange }: { jobId: string; name?: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [expanded, setExpanded] = useState(false)
  const head = useSWR<PreviewPage>(open ? previewRowsKey(jobId, 0, 'valid', '') : null, fetchJson, { revalidateOnFocus: false })
  const title = head.data?.job.name ?? name ?? 'Leads'
  const sub = head.data?.job
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setExpanded(false)
        onOpenChange(o)
      }}
    >
      <DialogContent
        className={cn(
          'flex flex-col gap-0 overflow-hidden p-0',
          expanded
            ? 'top-0 left-0 h-dvh w-screen max-w-none translate-x-0 translate-y-0 rounded-none sm:max-w-none'
            : 'h-[min(86vh,900px)] w-[min(1280px,calc(100%-2rem))] sm:max-w-[min(1280px,calc(100%-2rem))]'
        )}
      >
        <div className="flex min-w-0 flex-col gap-0.5 px-4 pt-4 pr-12">
          <DialogTitle className="min-w-0 text-[15px] font-semibold text-fg">
            <RenamableName jobId={jobId} name={title} />
          </DialogTitle>
          <DialogDescription className="truncate text-[11.5px] text-fg-46">
            {sub
              ? [sub.filename, `${fmt.format(sub.total_rows)} rows`, sub.instantly_campaign_name ? `→ ${sub.instantly_campaign_name}` : null].filter(Boolean).join(' · ')
              : 'Validated leads'}
          </DialogDescription>
        </div>
        {open && <LeadsPreview jobId={jobId} variant="dialog" expanded={expanded} onToggleExpanded={() => setExpanded((x) => !x)} />}
      </DialogContent>
    </Dialog>
  )
}

/** Eye icon that opens the preview dialog. */
export function PreviewLeadsButton({ jobId, name, className }: { jobId: string; name?: string; className?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Preview leads"
        title="Preview leads"
        className={className}
        onClick={(e) => {
          e.stopPropagation()
          setOpen(true)
        }}
      >
        <Eye />
      </Button>
      <ValidatedPreviewDialog jobId={jobId} name={name} open={open} onOpenChange={setOpen} />
    </>
  )
}
