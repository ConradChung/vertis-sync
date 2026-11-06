'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import useSWR, { preload } from 'swr'
import { toast } from 'sonner'
import { ArrowDown, ArrowUp, ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, ClipboardPaste, Download, FolderPlus, ListPlus, Pencil, Plus, Send, Trash2 } from 'lucide-react'
import { fetchJson } from '@/hooks/fetcher'
import { relTime } from '@/components/campaigns/CampaignTable'
import { GlassCard } from '@/components/ui/glass-card'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { LIST_COLUMNS, type EditableField, type ListItem } from '@/lib/leads/lists/model'
import { InfluencerSheet } from '@/components/leads/InfluencerSheet'
import { cn } from '@/lib/utils'

/**
 * `/import/leads`: persistent lead lists. Left, the folder tree (folders are
 * the chat projects, then Unfiled) with each list's rows, email coverage and
 * last change; right, the selected list (`?list=<id>`) as a paged, sortable,
 * searchable table with inline cell edits, row delete, add / paste rows,
 * Export CSV and Send to validator (an owner click with a confirm; it stops
 * at the usual ingest gate).
 */

interface LeadListRow {
  id: string
  name: string
  notes: string | null
  project_id: string | null
  project_default: boolean
  item_count: number
  email_count: number
  sent_at: string | null
  sent_rows: number | null
  sent_ingest_id: string | null
  sent_job_id: string | null
  /** The sources' own columns (an actor's output fields, a sheet's headers); empty on lists without any. */
  columns: string[]
  /** 'influencer_candidates': an influencer candidate batch, reviewed in InfluencerSheet. */
  sheet_kind?: 'leads' | 'influencer_candidates'
  influencer_batch_id?: string | null
  updated_at: string
}
interface Folder {
  id: string | null
  kind?: 'project' | 'influencers' | 'unfiled'
  name: string
  lists: LeadListRow[]
}
interface Page {
  rows: { idx: number; item: Partial<ListItem>; cells?: Record<string, string> | null; source: string | null }[]
  total: number
}

const PAGE_SIZE = 100
/** Columns the server can sort by (plain names; see lib/leads/lists/store.ts isSortable). */
const SORTABLE = /^[A-Za-z0-9_]{1,80}$/
const fmt = new Intl.NumberFormat('en-US')
const pct = (l: LeadListRow) => (l.item_count ? Math.round((l.email_count / l.item_count) * 100) : 0)

async function api<T = Record<string, unknown>>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const json = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
  return json
}

const fail = (err: unknown) => toast.error(err instanceof Error ? err.message : String(err))

export function LeadsScreen() {
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const selectedId = params.get('list')
  const tree = useSWR<{ folders: Folder[] }>('/api/lead-lists', fetchJson, { keepPreviousData: true })
  const folders = useMemo(() => tree.data?.folders ?? [], [tree.data])
  const selected = useMemo(() => folders.flatMap((f) => f.lists).find((l) => l.id === selectedId) ?? null, [folders, selectedId])
  const select = useCallback((id: string) => router.replace(`${pathname}?list=${id}`, { scroll: false }), [router, pathname])
  const [dialog, setDialog] = useState<null | { kind: 'new_folder' } | { kind: 'rename_folder'; folder: Folder } | { kind: 'delete_folder'; folder: Folder } | { kind: 'new_list'; folderId: string | null }>(null)
  const refresh = () => void tree.mutate()

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
      <GlassCard className="gap-0 py-0">
        <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
          <h2 className="text-[13px] font-medium text-fg">Lists</h2>
          <div className="flex gap-1">
            <Button variant="ghost" size="icon-sm" aria-label="New folder" onClick={() => setDialog({ kind: 'new_folder' })}>
              <FolderPlus className="size-4" />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="New list" onClick={() => setDialog({ kind: 'new_list', folderId: null })}>
              <ListPlus className="size-4" />
            </Button>
          </div>
        </div>
        <nav aria-label="Lead lists" className="flex flex-col gap-1 p-2">
          {tree.error && !tree.data ? (
            <p className="px-2 py-3 text-[12px] text-fg-46" role="alert">
              Couldn&apos;t load lists.
            </p>
          ) : !tree.data ? (
            <p className="px-2 py-3 text-[12px] text-fg-46">Loading…</p>
          ) : (
            folders.map((f) => (
              <FolderNode
                key={f.id ?? 'unfiled'}
                folder={f}
                selectedId={selectedId}
                onSelect={select}
                onNewList={f.kind === 'influencers' ? undefined : () => setDialog({ kind: 'new_list', folderId: f.id })}
                onRename={f.id ? () => setDialog({ kind: 'rename_folder', folder: f }) : undefined}
                onDelete={f.id ? () => setDialog({ kind: 'delete_folder', folder: f }) : undefined}
              />
            ))
          )}
        </nav>
      </GlassCard>

      {selected?.sheet_kind === 'influencer_candidates' && selected.influencer_batch_id ? (
        <InfluencerSheet key={selected.id} batchId={selected.influencer_batch_id} name={selected.name} />
      ) : selected ? (
        <ListPanel
          key={selected.id}
          list={selected}
          folders={folders}
          page={Math.max(0, (Number(params.get('page')) || 1) - 1)}
          onPage={(p) => router.replace(`${pathname}?list=${selected.id}${p > 0 ? `&page=${p + 1}` : '&page=1'}`, { scroll: false })}
          onChanged={refresh}
          onDeleted={() => {
            refresh()
            router.replace(pathname, { scroll: false })
          }} />
      ) : (
        <GlassCard className="px-5 py-10 text-center text-[13px] text-fg-46">
          {selectedId && tree.data ? 'That list no longer exists.' : 'Pick a list on the left, or create one. The agent can also collect leads into lists for you.'}
        </GlassCard>
      )}

      <NameDialog
        open={dialog?.kind === 'new_folder' || dialog?.kind === 'rename_folder'}
        title={dialog?.kind === 'rename_folder' ? 'Rename folder' : 'New folder'}
        description="Folders are your Agent projects: chats filed in a project add the leads they find to its list."
        initial={dialog?.kind === 'rename_folder' ? dialog.folder.name : ''}
        onClose={() => setDialog(null)}
        onSubmit={async (name) => {
          if (dialog?.kind === 'rename_folder') await api(`/api/agent/projects/${dialog.folder.id}`, 'PATCH', { name })
          else await api('/api/agent/projects', 'POST', { name })
          refresh()
        }}
      />
      <NameDialog
        open={dialog?.kind === 'new_list'}
        title="New lead list"
        initial=""
        onClose={() => setDialog(null)}
        onSubmit={async (name) => {
          const r = await api<{ list: { id: string } }>('/api/lead-lists', 'POST', { name, project_id: dialog?.kind === 'new_list' ? dialog.folderId : null })
          refresh()
          select(r.list.id)
        }}
      />
      <Confirm
        open={dialog?.kind === 'delete_folder'}
        title={`Delete the folder "${dialog?.kind === 'delete_folder' ? dialog.folder.name : ''}"?`}
        body="This deletes the Agent project: its chats move to Unfiled, its project files and notes are removed, and its lead lists move to Unfiled (they are kept)."
        action="Delete folder"
        destructive
        onClose={() => setDialog(null)}
        onConfirm={async () => {
          if (dialog?.kind === 'delete_folder') await api(`/api/agent/projects/${dialog.folder.id}`, 'DELETE')
          refresh()
        }}
      />
    </div>
  )
}

function FolderNode({
  folder,
  selectedId,
  onSelect,
  onNewList,
  onRename,
  onDelete,
}: {
  folder: Folder
  selectedId: string | null
  onSelect: (id: string) => void
  onNewList?: () => void
  onRename?: () => void
  onDelete?: () => void
}) {
  const holdsSelected = folder.lists.some((l) => l.id === selectedId)
  const [open, setOpen] = useState(holdsSelected || folder.lists.length > 0)
  useEffect(() => {
    if (holdsSelected) setOpen(true)
  }, [holdsSelected])
  return (
    <details open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)} className="group rounded-control">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-control px-2 py-1.5 text-[12.5px] font-medium text-fg-70 hover:bg-white/4 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1 truncate">{folder.name}</span>
        <span className="font-mono text-[11px] text-fg-24">{folder.lists.length}</span>
        <span className="hidden gap-0.5 group-hover:flex">
          {onNewList && <IconAction label={`New list in ${folder.name}`} onClick={onNewList} icon={Plus} />}
          {onRename && <IconAction label={`Rename ${folder.name}`} onClick={onRename} icon={Pencil} />}
          {onDelete && <IconAction label={`Delete ${folder.name}`} onClick={onDelete} icon={Trash2} />}
        </span>
      </summary>
      <ul className="mt-0.5 flex flex-col gap-0.5 pl-2">
        {folder.lists.length === 0 && <li className="px-2 py-1 text-[11.5px] text-fg-24">No lists</li>}
        {folder.lists.map((l) => (
          <li key={l.id}>
            <button
              type="button"
              onClick={() => onSelect(l.id)}
              aria-current={l.id === selectedId ? 'true' : undefined}
              className={cn('w-full rounded-control px-2 py-1.5 text-left hover:bg-white/4', l.id === selectedId && 'bg-accent')}
            >
              <span className="block truncate text-[13px] text-fg">{l.name}</span>
              <span className="block text-[11px] text-fg-46">
                {l.sheet_kind === 'influencer_candidates' ? `${fmt.format(l.item_count)} candidates` : `${fmt.format(l.item_count)} rows · ${pct(l)}% email`} · {relTime(l.updated_at)}
                {l.sent_at && ' · sent'}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </details>
  )
}

function IconAction({ label, onClick, icon: Icon }: { label: string; onClick: () => void; icon: typeof Plus }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onClick()
      }}
      className="rounded p-0.5 text-fg-46 hover:text-fg"
    >
      <Icon className="size-3.5" />
    </button>
  )
}

function ListPanel({
  list,
  folders,
  page,
  onPage,
  onChanged,
  onDeleted,
}: {
  list: LeadListRow
  folders: Folder[]
  /** 0-based; the URL carries it 1-based (`?page=2`) so deep links and refreshes land on it. */
  page: number
  onPage: (page: number) => void
  onChanged: () => void
  onDeleted: () => void
}) {
  const setPage = (p: number) => onPage(Math.max(0, p))
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<{ field: string; dir: 'asc' | 'desc' }>({ field: 'idx', dir: 'asc' })
  // The list's own columns; a list with none (older rows) shows the readable labels.
  const columns = list.columns?.length ? list.columns : LIST_COLUMNS.map((c) => c.label)
  const cellOf = (r: Page['rows'][number], c: string) => r.cells?.[c] ?? (list.columns?.length ? '' : ((r.item[LIST_COLUMNS.find((x) => x.label === c)?.key ?? 'name'] as string | null | undefined) ?? ''))
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [dialog, setDialog] = useState<null | 'send' | 'delete' | 'rows' | 'paste' | 'add' | 'rename'>(null)
  useEffect(() => {
    const t = setTimeout(() => {
      const next = q.trim()
      if (next === query) return
      setQuery(next)
      if (page !== 0) onPage(0)
    }, 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the typed text restarts the debounce
  }, [q])
  const keyFor = (p: number) => `/api/lead-lists/${list.id}/items?${new URLSearchParams({ page: String(p), page_size: String(PAGE_SIZE), sort: sort.field, dir: sort.dir, ...(query ? { q: query } : {}) })}`
  const key = keyFor(page)
  const rows = useSWR<Page>(key, fetchJson, { keepPreviousData: true })
  const total = rows.data?.total ?? 0
  // ▶ should feel instant: fetch the next page in the background.
  useEffect(() => {
    if ((page + 1) * PAGE_SIZE < total) void preload(keyFor(page + 1), fetchJson)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyFor is derived from these
  }, [page, total, query, sort.field, sort.dir, list.id])
  const reload = () => {
    void rows.mutate()
    onChanged()
  }
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const toggleSort = (field: string) => setSort((s) => (s.field === field ? { field, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { field, dir: 'asc' }))
  const folderOptions = folders.map((f) => ({ value: f.id ?? '', label: f.name }))

  const saveCell = async (idx: number, column: string, value: string) => {
    try {
      await api(`/api/lead-lists/${list.id}/items/${idx}`, 'PATCH', { column, value })
      reload()
    } catch (err) {
      fail(err)
    }
  }

  return (
    <GlassCard className="min-w-0 gap-0 py-0">
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-1.5 truncate text-[15px] font-medium text-fg">
            {list.name}
            <IconAction label="Rename list" onClick={() => setDialog('rename')} icon={Pencil} />
          </h2>
          <p className="text-[11.5px] text-fg-46">
            {fmt.format(list.item_count)} rows · {fmt.format(list.email_count)} with an email
            {list.sent_at && ` · sent ${relTime(list.sent_at)} (${fmt.format(list.sent_rows ?? 0)} rows)`}
            {list.sent_job_id && (
              <>
                {' · '}
                <Link className="text-violet-soft hover:text-fg" href="/progress">
                  validation job
                </Link>
              </>
            )}
          </p>
        </div>
        <SimpleSelect
          size="sm"
          aria-label="Folder"
          className="w-44"
          value={list.project_id ?? ''}
          options={folderOptions}
          onValueChange={async (v) => {
            try {
              await api(`/api/lead-lists/${list.id}`, 'PATCH', { project_id: v || null })
              onChanged()
            } catch (err) {
              fail(err)
            }
          }}
        />
        <a href={`/api/lead-lists/${list.id}/export`} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>
          <Download className="size-3.5" /> Export CSV
        </a>
        <Button size="sm" onClick={() => setDialog('send')} disabled={list.email_count < 1}>
          <Send className="size-3.5" /> Send to validator
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Delete list" onClick={() => setDialog('delete')}>
          <Trash2 className="size-4" />
        </Button>
        {list.email_count < 1 && <p className="w-full text-right text-[11.5px] text-amber">No row has an email yet</p>}
      </header>

      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, company, email, title, city" aria-label="Search rows" className="h-8 max-w-xs" />
        <div className="flex-1" />
        {picked.size > 0 && (
          <Button variant="outline" size="sm" onClick={() => setDialog('rows')}>
            <Trash2 className="size-3.5" /> Delete {picked.size} row{picked.size === 1 ? '' : 's'}
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => setDialog('add')}>
          <Plus className="size-3.5" /> Add row
        </Button>
        <Button variant="outline" size="sm" onClick={() => setDialog('paste')}>
          <ClipboardPaste className="size-3.5" /> Paste rows
        </Button>
      </div>

      <Pager page={page} pages={pages} total={total} onPage={setPage} />
      <div
        className="overflow-x-auto outline-none focus-visible:ring-2 focus-visible:ring-ring"
        role="region"
        aria-label={`${list.name} table`}
        tabIndex={0}
        onKeyDown={(e) => {
          // ← / → page while the table has focus, never while a cell is being edited.
          if ((e.target as HTMLElement).tagName === 'INPUT') return
          if (e.key === 'ArrowLeft' && page > 0) setPage(page - 1)
          if (e.key === 'ArrowRight' && page + 1 < pages) setPage(page + 1)
        }}
      >
        <Table aria-label={`${list.name} rows`} className="min-w-max text-[12.5px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-8 pl-4" />
              <TableHead className="w-12 text-fg-46">#</TableHead>
              {columns.map((c) => (
                <TableHead key={c} className="whitespace-nowrap" aria-sort={sort.field === c ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                  {SORTABLE.test(c) ? (
                    <button type="button" className="inline-flex items-center gap-1 text-fg-46 hover:text-fg" onClick={() => toggleSort(c)}>
                      {c}
                      {sort.field === c && (sort.dir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
                    </button>
                  ) : (
                    <span className="text-fg-46">{c}</span>
                  )}
                </TableHead>
              ))}
              <TableHead className="pr-4 text-fg-46">Source</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(rows.data?.rows ?? []).map((r) => (
              <TableRow key={r.idx}>
                <TableCell className="pl-4">
                  <input
                    type="checkbox"
                    aria-label={`Select row ${r.idx + 1}`}
                    checked={picked.has(r.idx)}
                    onChange={(e) =>
                      setPicked((s) => {
                        const n = new Set(s)
                        if (e.target.checked) n.add(r.idx)
                        else n.delete(r.idx)
                        return n
                      })
                    }
                  />
                </TableCell>
                <TableCell className="font-mono text-fg-24">{r.idx + 1}</TableCell>
                {columns.map((c) => (
                  <TableCell key={c} className="max-w-[220px]">
                    <EditableCell label={`${c}, row ${r.idx + 1}`} value={cellOf(r, c)} onSave={(v) => saveCell(r.idx, c, v)} />
                  </TableCell>
                ))}
                <TableCell className="pr-4 text-fg-46">{r.source ?? '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {rows.data && !rows.data.rows?.length && <p className="px-4 py-6 text-center text-[12.5px] text-fg-46">{query ? 'No row matches.' : 'This list is empty. Add or paste rows, or ask the agent to fill it.'}</p>}
      </div>

      <Pager page={page} pages={pages} total={total} onPage={setPage} bottom />

      <Confirm
        open={dialog === 'send'}
        title={`Send "${list.name}" to the validator?`}
        body={`${fmt.format(list.email_count)} of ${fmt.format(list.item_count)} rows have an email; those go as a CSV import to the usual Approve / Deny ingest gate. Nothing is validated or spent until you approve that gate.`}
        action={`Send ${fmt.format(list.email_count)} rows`}
        onClose={() => setDialog(null)}
        onConfirm={async () => {
          await api(`/api/lead-lists/${list.id}/send`, 'POST')
          toast.success('Sent to the ingest gate — approve it in Validate or Telegram.')
          onChanged()
        }}
      />
      <Confirm
        open={dialog === 'delete'}
        title={`Delete "${list.name}"?`}
        body={`The list and its ${fmt.format(list.item_count)} rows are deleted. This cannot be undone.`}
        action="Delete list"
        destructive
        onClose={() => setDialog(null)}
        onConfirm={async () => {
          await api(`/api/lead-lists/${list.id}`, 'DELETE')
          onDeleted()
        }}
      />
      <Confirm
        open={dialog === 'rows'}
        title={`Delete ${picked.size} row${picked.size === 1 ? '' : 's'}?`}
        body="They are removed from this list. This cannot be undone."
        action="Delete rows"
        destructive
        onClose={() => setDialog(null)}
        onConfirm={async () => {
          await api(`/api/lead-lists/${list.id}/items`, 'DELETE', { idxs: [...picked] })
          setPicked(new Set())
          reload()
        }}
      />
      <NameDialog
        open={dialog === 'rename'}
        title="Rename list"
        initial={list.name}
        onClose={() => setDialog(null)}
        onSubmit={async (name) => {
          await api(`/api/lead-lists/${list.id}`, 'PATCH', { name })
          onChanged()
        }}
      />
      <PasteDialog open={dialog === 'paste'} onClose={() => setDialog(null)} onAppend={async (text) => appendReport(await api(`/api/lead-lists/${list.id}/items`, 'POST', { source: { kind: 'paste', text } }), reload)} />
      <AddRowDialog open={dialog === 'add'} onClose={() => setDialog(null)} onAdd={async (row) => appendReport(await api(`/api/lead-lists/${list.id}/items`, 'POST', { source: { kind: 'inline', rows: [row] } }), reload)} />
    </GlassCard>
  )
}

/** "Rows 101–200 of 4,312 · page 2 of 44" with first / previous / next / last (disabled at the ends). */
function Pager({ page, pages, total, onPage, bottom }: { page: number; pages: number; total: number; onPage: (p: number) => void; bottom?: boolean }) {
  const from = total ? page * PAGE_SIZE + 1 : 0
  const to = Math.min(total, (page + 1) * PAGE_SIZE)
  const btn = (label: string, Icon: typeof ChevronLeft, target: number, disabled: boolean) => (
    <Button variant="ghost" size="icon-sm" aria-label={label} title={label} disabled={disabled} onClick={() => onPage(target)}>
      <Icon className="size-4" />
    </Button>
  )
  return (
    <div className={cn('flex items-center justify-between gap-2 px-4 py-2 text-[12px] text-fg-46', bottom ? 'border-t border-line' : 'border-b border-line')}>
      <span>{total ? `Rows ${fmt.format(from)}–${fmt.format(to)} of ${fmt.format(total)} · page ${fmt.format(page + 1)} of ${fmt.format(pages)}` : 'No rows'}</span>
      <span className="flex items-center gap-0.5">
        {btn('First page', ChevronFirst, 0, page === 0)}
        {btn('Previous page', ChevronLeft, page - 1, page === 0)}
        {btn('Next page', ChevronRight, page + 1, page + 1 >= pages)}
        {btn('Last page', ChevronLast, pages - 1, page + 1 >= pages)}
      </span>
    </div>
  )
}

function appendReport(r: Record<string, unknown>, reload: () => void) {
  toast.success(String(r.line ?? 'Added'))
  reload()
}

function EditableCell({ label, value, onSave }: { label: string; value: string; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  if (editing) {
    const commit = () => {
      setEditing(false)
      if (draft.trim() !== value.trim()) onSave(draft)
    }
    return (
      <input
        autoFocus
        aria-label={label}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') {
            setDraft(value)
            setEditing(false)
          }
        }}
        className="w-full rounded border border-primary/50 bg-(--glass-fill) px-1.5 py-0.5 text-[12.5px] text-fg outline-none"
      />
    )
  }
  return (
    <button type="button" aria-label={`Edit ${label}`} onClick={() => setEditing(true)} className="block w-full truncate rounded px-1.5 py-0.5 text-left text-fg-70 hover:bg-white/6" title={value}>
      {value || <span className="text-fg-24">—</span>}
    </button>
  )
}

function Confirm({ open, title, body, action, destructive, onClose, onConfirm }: { open: boolean; title: string; body: string; action: string; destructive?: boolean; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await onConfirm()
                onClose()
              } catch (err) {
                fail(err)
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? 'Working…' : action}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function NameDialog({ open, title, description, initial, onClose, onSubmit }: { open: boolean; title: string; description?: string; initial: string; onClose: () => void; onSubmit: (name: string) => Promise<void> }) {
  const [name, setName] = useState(initial)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) setName(initial)
  }, [open, initial])
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault()
            if (!name.trim()) return
            setBusy(true)
            try {
              await onSubmit(name.trim())
              onClose()
            } catch (err) {
              fail(err)
            } finally {
              setBusy(false)
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <Input autoFocus aria-label="Name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function PasteDialog({ open, onClose, onAppend }: { open: boolean; onClose: () => void; onAppend: (text: string) => Promise<void> }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Paste rows</DialogTitle>
          <DialogDescription>Copy rows from a spreadsheet (or CSV) with the header row first. Columns are matched like an attached sheet; duplicates are skipped.</DialogDescription>
        </DialogHeader>
        <Textarea aria-label="Rows to paste" rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder={'Full Name\tCompany\tEmail\nJane Doe\tAcme\tjane@acme.com'} />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            disabled={busy || !text.trim()}
            onClick={async () => {
              setBusy(true)
              try {
                await onAppend(text)
                setText('')
                onClose()
              } catch (err) {
                fail(err)
              } finally {
                setBusy(false)
              }
            }}
          >
            Add rows
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const ADD_FIELDS: { key: EditableField; label: string }[] = [
  { key: 'first_name', label: 'First name' },
  { key: 'last_name', label: 'Last name' },
  { key: 'title', label: 'Title' },
  { key: 'company', label: 'Company' },
  { key: 'email', label: 'Email' },
  { key: 'website', label: 'Website' },
  { key: 'linkedin_url', label: 'LinkedIn' },
  { key: 'phone', label: 'Phone' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
]

function AddRowDialog({ open, onClose, onAdd }: { open: boolean; onClose: () => void; onAdd: (row: Partial<Record<EditableField, string>>) => Promise<void> }) {
  const [row, setRow] = useState<Partial<Record<EditableField, string>>>({})
  const [busy, setBusy] = useState(false)
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true)
            try {
              await onAdd(Object.fromEntries(Object.entries(row).filter(([, v]) => v?.trim())))
              setRow({})
              onClose()
            } catch (err) {
              fail(err)
            } finally {
              setBusy(false)
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Add a row</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-2">
            {ADD_FIELDS.map((f) => (
              <Input key={f.key} aria-label={f.label} placeholder={f.label} value={row[f.key] ?? ''} onChange={(e) => setRow((r) => ({ ...r, [f.key]: e.target.value }))} />
            ))}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !Object.values(row).some((v) => v?.trim())}>
              Add
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
