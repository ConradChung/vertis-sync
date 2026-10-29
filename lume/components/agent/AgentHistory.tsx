'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Loader2,
  MoreHorizontal,
  Pencil,
  SquarePen,
  Trash2,
  Upload,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { MoveToProjectDialog } from '@/components/agent/MoveToProject'
import { groupConversations, type ConversationSummary } from '@/lib/agent/history'
import {
  CHAT_DRAG,
  createProject,
  deleteProject,
  dragKind,
  moveChat,
  PROJECT_DRAG,
  reorderIds,
  saveProjectOrder,
  shiftId,
  uploadProjectFiles,
} from '@/lib/agent/projectClient'
import { ACCEPT, type ProjectSummary } from '@/lib/agent/projectModel'
import type { ProjectList } from '@/hooks/useProjectList'
import { cn } from '@/lib/utils'

export interface ConversationList {
  /** null until the first load. */
  items: ConversationSummary[] | null
  error: string | null
  setItems: React.Dispatch<React.SetStateAction<ConversationSummary[] | null>>
  setError: (e: string | null) => void
}

/**
 * The owner's conversations, refetched whenever `refreshKey` changes (a run
 * finished, a conversation was created). One list feeds both the sidebar and
 * the narrow-screen sheet.
 */
export function useConversationList(refreshKey: number): ConversationList {
  const [items, setItems] = useState<ConversationSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/agent/conversations', { credentials: 'same-origin' })
      if (!res.ok) throw new Error(`Could not load history (${res.status})`)
      const body = (await res.json()) as { conversations: ConversationSummary[] }
      setItems(body.conversations)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load history')
      setItems((v) => v ?? [])
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  return { items, error, setItems, setError }
}

/** File (or unfile) a chat optimistically; reverts and reports on failure. */
export function useMoveChat(list: ConversationList) {
  const { items, setItems, setError } = list
  return useCallback(
    async (id: string, projectId: string | null) => {
      const prev = items
      setItems((v) => v?.map((c) => (c.id === id ? { ...c, project_id: projectId } : c)) ?? v)
      const r = await moveChat(id, projectId)
      if (!r.ok) {
        setItems(prev)
        setError(r.error)
        return false
      }
      return true
    },
    [items, setItems, setError]
  )
}

export interface AgentHistoryProps {
  list: ConversationList
  projects: ProjectList
  activeId: string | null
  /** A run is live: switching away is blocked until it ends. */
  busy: boolean
  onSelect: (id: string) => void
  onNew: () => void
  /** "New chat in project". */
  onNewInProject: (projectId: string) => void
  onOpenProject: (projectId: string) => void
  /** The active conversation was deleted. */
  onDeletedActive: () => void
  className?: string
}

const OPEN_KEY = 'lume.agent.projects.open'

function readOpen(): Set<string> {
  try {
    const raw = localStorage.getItem(OPEN_KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}

type DropAt = { id: string; where: 'into' | 'before' | 'after' } | null

/**
 * The Agent tab's sidebar: New chat / New project, then the projects
 * (collapsible groups of their chats) and Unfiled (chats grouped Today /
 * Yesterday / Previous 7 days / Older).
 *
 * Drag and drop (native HTML5): a chat onto a project files it, onto Unfiled
 * unfiles it; a project onto another reorders; files from the OS onto a
 * project are added to its knowledge. "Move to project" in each chat's menu
 * and Move up / down in each project's menu do the same without a pointer.
 */
export function AgentHistory({
  list,
  projects,
  activeId,
  busy,
  onSelect,
  onNew,
  onNewInProject,
  onOpenProject,
  onDeletedActive,
  className,
}: AgentHistoryProps) {
  const { items, error, setItems, setError } = list
  const [renaming, setRenaming] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConversationSummary | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [moving, setMoving] = useState<ConversationSummary | null>(null)
  const [creating, setCreating] = useState(false)
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const [dropAt, setDropAt] = useState<DropAt>(null)
  const [unfiledOver, setUnfiledOver] = useState(false)
  const [uploading, setUploading] = useState<Record<string, number>>({})
  const [removing, setRemoving] = useState<ProjectSummary | null>(null)
  const move = useMoveChat(list)

  const projectList = useMemo(() => projects.items ?? [], [projects.items])
  const known = useMemo(() => new Set(projectList.map((p) => p.id)), [projectList])
  // A chat whose project is gone (or not loaded yet) shows as Unfiled.
  const projectOf = useCallback((c: ConversationSummary) => (c.project_id && known.has(c.project_id) ? c.project_id : null), [known])
  const unfiled = useMemo(() => (items ?? []).filter((c) => !projectOf(c)), [items, projectOf])
  const groups = useMemo(() => groupConversations(unfiled), [unfiled])
  const byProject = useMemo(() => {
    const m = new Map<string, ConversationSummary[]>()
    for (const c of items ?? []) {
      const p = projectOf(c)
      if (p) m.set(p, [...(m.get(p) ?? []), c])
    }
    return m
  }, [items, projectOf])

  useEffect(() => setOpen(readOpen()), [])
  const toggle = (id: string, force?: boolean) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (force ?? !next.has(id)) next.add(id)
      else next.delete(id)
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify([...next]))
      } catch {
        // per-viewer convenience only
      }
      return next
    })
  // The active chat's project opens so the chat is visible.
  const activeProject = items?.find((c) => c.id === activeId)
  const activeProjectId = activeProject ? projectOf(activeProject) : null
  useEffect(() => {
    if (activeProjectId) setOpen((prev) => (prev.has(activeProjectId) ? prev : new Set(prev).add(activeProjectId)))
  }, [activeProjectId])

  const rename = async (id: string, title: string) => {
    setRenaming(null)
    const t = title.trim()
    const prev = items
    if (!t || prev?.find((c) => c.id === id)?.title === t) return
    setItems((v) => v?.map((c) => (c.id === id ? { ...c, title: t } : c)) ?? v)
    const res = await fetch(`/api/agent/conversations/${id}`, {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: t }),
    }).catch(() => null)
    if (!res?.ok) {
      setItems(prev)
      setError('Rename failed')
    }
  }

  const remove = async () => {
    if (!confirm) return
    setDeleting(true)
    const res = await fetch(`/api/agent/conversations/${confirm.id}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    }).catch(() => null)
    setDeleting(false)
    if (!res?.ok && res?.status !== 404) {
      setError('Delete failed')
      setConfirm(null)
      return
    }
    setItems((v) => v?.filter((c) => c.id !== confirm.id) ?? v)
    if (confirm.id === activeId) onDeletedActive()
    setConfirm(null)
  }

  const reorder = async (ids: string[]) => {
    const prev = projects.items
    const byId = new Map(projectList.map((p) => [p.id, p]))
    projects.setItems(ids.map((id, position) => ({ ...byId.get(id)!, position })))
    const r = await saveProjectOrder(ids)
    if (!r.ok) {
      projects.setItems(prev)
      setError(r.error)
    }
  }

  const addFiles = async (projectId: string, files: File[]) => {
    if (!files.length) return
    setUploading((u) => ({ ...u, [projectId]: (u[projectId] ?? 0) + files.length }))
    const { added, errors } = await uploadProjectFiles(projectId, files)
    setUploading((u) => ({ ...u, [projectId]: Math.max(0, (u[projectId] ?? 0) - files.length) }))
    if (added.length) {
      toast.success(added.length === 1 ? `Added ${added[0].name}` : `Added ${added.length} files`)
      void projects.reload()
    }
    for (const e of errors) toast.error(e)
    if (errors.length) setError(errors[0])
  }

  const create = async (name: string) => {
    setCreating(false)
    const n = name.trim()
    if (!n) return
    const r = await createProject(n)
    if (!r.ok) {
      setError(r.error)
      return
    }
    projects.setItems((v) => [...(v ?? []), { ...r.project, item_count: 0, total_bytes: 0 }])
    toggle(r.project.id, true)
  }

  const removeProject = async () => {
    if (!removing) return
    const p = removing
    setRemoving(null)
    const r = await deleteProject(p.id)
    if (!r.ok) {
      setError(r.error)
      return
    }
    projects.setItems((v) => v?.filter((x) => x.id !== p.id) ?? v)
    setItems((v) => v?.map((c) => (c.project_id === p.id ? { ...c, project_id: null } : c)) ?? v)
  }

  /** Drop on a project row. */
  const onProjectDrop = (e: React.DragEvent, p: ProjectSummary) => {
    const kind = dragKind(e.dataTransfer)
    const at = dropAt
    setDropAt(null)
    if (!kind) return
    e.preventDefault()
    if (kind === 'files') {
      void addFiles(p.id, Array.from(e.dataTransfer.files ?? []))
      toggle(p.id, true)
    } else if (kind === 'chat') {
      const id = e.dataTransfer.getData(CHAT_DRAG)
      if (id) void move(id, p.id).then((ok) => ok && toggle(p.id, true))
    } else if (kind === 'project') {
      const id = e.dataTransfer.getData(PROJECT_DRAG)
      const ids = projectList.map((x) => x.id)
      const next = reorderIds(ids, id, p.id, at?.where === 'after')
      if (next !== ids) void reorder(next)
    }
  }

  const itemProps = (c: ConversationSummary) => ({
    c,
    active: c.id === activeId,
    disabled: busy && c.id !== activeId,
    editing: renaming === c.id,
    onSelect: () => onSelect(c.id),
    onRename: () => setRenaming(c.id),
    onRenameDone: (t: string) => void rename(c.id, t),
    onRenameCancel: () => setRenaming(null),
    onDelete: () => setConfirm(c),
    onMove: () => setMoving(c),
  })

  return (
    <nav aria-label="Chat history" className={cn('flex min-h-0 flex-col', className)}>
      <div className="flex gap-1.5">
        <Button variant="outline" className="h-9 min-w-0 flex-1 justify-start gap-2" onClick={onNew} disabled={busy}>
          <SquarePen className="size-4" /> New chat
        </Button>
        <Button variant="outline" size="icon" className="size-9 shrink-0" onClick={() => setCreating(true)} aria-label="New project" title="New project">
          <FolderPlus className="size-4" />
        </Button>
      </div>

      <div className="thin-scroll -mx-1 mt-4 min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {(creating || projectList.length > 0) && (
          <section className="mb-4" aria-label="Projects">
            <h3 className="mb-1 px-2 text-[11px] font-medium tracking-[0.06em] text-fg-46 uppercase">Projects</h3>
            {creating && <NewProjectInput onDone={(n) => void create(n)} onCancel={() => setCreating(false)} />}
            <ul className="flex flex-col gap-0.5">
              {projectList.map((p, i) => {
                const chats = byProject.get(p.id) ?? []
                const expanded = open.has(p.id)
                const over = dropAt?.id === p.id ? dropAt.where : null
                return (
                  <li key={p.id}>
                    <ProjectRow
                      p={p}
                      count={chats.length}
                      expanded={expanded}
                      over={over}
                      uploading={(uploading[p.id] ?? 0) > 0}
                      first={i === 0}
                      last={i === projectList.length - 1}
                      onToggle={() => toggle(p.id)}
                      onOpen={() => onOpenProject(p.id)}
                      onNewChat={() => onNewInProject(p.id)}
                      onAddFiles={(files) => void addFiles(p.id, files)}
                      onShift={(by) => void reorder(shiftId(projectList.map((x) => x.id), p.id, by))}
                      onDelete={() => setRemoving(p)}
                      onDragOver={(e) => {
                        const kind = dragKind(e.dataTransfer)
                        if (!kind) return
                        e.preventDefault()
                        e.dataTransfer.dropEffect = kind === 'files' ? 'copy' : 'move'
                        let where: 'into' | 'before' | 'after' = 'into'
                        if (kind === 'project') {
                          const r = e.currentTarget.getBoundingClientRect()
                          where = e.clientY > r.top + r.height / 2 ? 'after' : 'before'
                        }
                        if (over !== where) setDropAt({ id: p.id, where })
                      }}
                      onDragLeave={(e) => {
                        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt((d) => (d?.id === p.id ? null : d))
                      }}
                      onDrop={(e) => onProjectDrop(e, p)}
                    />
                    {expanded && (
                      <ul className="mt-0.5 ml-3 flex flex-col gap-0.5 border-l border-line pl-1.5" aria-label={`Chats in ${p.name}`}>
                        {chats.length === 0 ? (
                          <li className="px-2 py-1.5 text-[12px] text-fg-24">Drop chats or files here</li>
                        ) : (
                          chats.map((c) => (
                            <li key={c.id}>
                              <HistoryItem {...itemProps(c)} />
                            </li>
                          ))
                        )}
                      </ul>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        <section
          aria-label="Unfiled chats"
          data-drop-target="unfiled"
          className={cn('-mx-1 rounded-control px-1 pb-1 transition-colors', unfiledOver && 'bg-primary/8 ring-1 ring-primary/70')}
          onDragOver={(e) => {
            if (dragKind(e.dataTransfer) !== 'chat') return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            if (!unfiledOver) setUnfiledOver(true)
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setUnfiledOver(false)
          }}
          onDrop={(e) => {
            setUnfiledOver(false)
            if (dragKind(e.dataTransfer) !== 'chat') return
            e.preventDefault()
            const id = e.dataTransfer.getData(CHAT_DRAG)
            if (id) void move(id, null)
          }}
        >
          {projectList.length > 0 && <h3 className="mb-1 px-2 pt-1 text-[11px] font-medium tracking-[0.06em] text-fg-46 uppercase">Unfiled</h3>}
          {items === null ? (
            <div className="flex flex-col gap-2" aria-label="Loading history">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-8 w-full rounded-control" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <p className="px-2 text-[13px] leading-5 text-fg-46">{error ?? 'No conversations yet. Chats you start are saved here.'}</p>
          ) : unfiled.length === 0 ? (
            <p className="px-2 py-1 text-[12px] text-fg-24">Every chat is in a project. Drag one here to unfile it.</p>
          ) : (
            groups.map((g) => (
              <div key={g.label} className="mb-4">
                <h4 className={cn('mb-1 px-2 text-[11px] font-medium tracking-[0.06em] uppercase', projectList.length ? 'text-fg-24' : 'text-fg-46')}>{g.label}</h4>
                <ul className="flex flex-col gap-0.5">
                  {g.items.map((c) => (
                    <li key={c.id}>
                      <HistoryItem {...itemProps(c)} />
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </section>
        {error && items && items.length > 0 && (
          <p className="px-2 text-[12px] text-red" role="alert">
            {error}
          </p>
        )}
      </div>

      <MoveToProjectDialog
        open={!!moving}
        onOpenChange={(o) => !o && setMoving(null)}
        title={moving?.title ?? ''}
        projects={projectList}
        current={moving ? projectOf(moving) : null}
        onPick={(pid) => moving && void move(moving.id, pid).then((ok) => ok && pid && toggle(pid, true))}
      />

      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && !deleting && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this chat?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{confirm?.title}&rdquo; will be removed from your history. Anything it already filed for approval stays in the queue.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <Button variant="destructive" onClick={() => void remove()} disabled={deleting}>
              {deleting ? 'Deleting…' : 'Delete'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this project?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{removing?.name}&rdquo; and its files and notes will be deleted. Its chats move to Unfiled; none are deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button variant="destructive" onClick={() => void removeProject()}>
              Delete project
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </nav>
  )
}

function NewProjectInput({ onDone, onCancel }: { onDone: (name: string) => void; onCancel: () => void }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const raf = requestAnimationFrame(() => ref.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [])
  const done = useRef(false)
  const finish = (v: string) => {
    if (done.current) return
    done.current = true
    onDone(v)
  }
  return (
    <input
      ref={ref}
      aria-label="Project name"
      placeholder="Project name"
      maxLength={80}
      className="mb-1 h-8 w-full rounded-control border border-primary/60 bg-(--glass-fill) px-2 text-[13px] text-fg outline-none placeholder:text-fg-24"
      onBlur={(e) => finish(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(e.currentTarget.value)
        if (e.key === 'Escape') {
          done.current = true
          onCancel()
        }
      }}
    />
  )
}

function ProjectRow({
  p,
  count,
  expanded,
  over,
  uploading,
  first,
  last,
  onToggle,
  onOpen,
  onNewChat,
  onAddFiles,
  onShift,
  onDelete,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  p: ProjectSummary
  count: number
  expanded: boolean
  over: 'into' | 'before' | 'after' | null
  uploading: boolean
  first: boolean
  last: boolean
  onToggle: () => void
  onOpen: () => void
  onNewChat: () => void
  onAddFiles: (files: File[]) => void
  onShift: (by: -1 | 1) => void
  onDelete: () => void
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void
  onDragLeave: (e: React.DragEvent<HTMLDivElement>) => void
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const Icon = expanded ? FolderOpen : Folder
  return (
    <div
      draggable
      data-drop-target="project"
      aria-label={`Project ${p.name}`}
      onDragStart={(e) => {
        e.dataTransfer.setData(PROJECT_DRAG, p.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        'group relative flex h-8 items-center rounded-control text-[13px] text-fg-70 transition-colors hover:bg-secondary hover:text-fg',
        over === 'into' && 'bg-primary/10 text-fg ring-1 ring-primary'
      )}
    >
      {over === 'before' && <span className="absolute -top-px right-1 left-1 h-0.5 rounded-full bg-primary" aria-hidden />}
      {over === 'after' && <span className="absolute right-1 -bottom-px left-1 h-0.5 rounded-full bg-primary" aria-hidden />}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={count ? `${p.name}, ${count} chat${count === 1 ? '' : 's'}` : p.name}
        title={p.name}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-control pr-1 pl-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight className={cn('size-3.5 shrink-0 text-fg-46 transition-transform', expanded && 'rotate-90')} />
        <Icon className={cn('size-4 shrink-0', over === 'into' ? 'text-positive' : 'text-fg-46')} />
        <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
        {uploading ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-positive" aria-label="Uploading" />
        ) : (
          count > 0 && <span className="shrink-0 text-[11px] text-fg-24 tabular-nums">{count}</span>
        )}
      </button>
      <input
        ref={fileRef}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        aria-label={`Add files to ${p.name}`}
        onChange={(e) => {
          onAddFiles(Array.from(e.currentTarget.files ?? []))
          e.currentTarget.value = ''
        }}
      />
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Options for project ${p.name}`}
          className="mr-1 grid size-6 shrink-0 place-items-center rounded-md text-fg-46 opacity-0 outline-none group-hover:opacity-100 hover:text-fg focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring data-popup-open:opacity-100 max-lg:opacity-100"
        >
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onClick={onOpen}>
            <FolderOpen /> Open project
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onNewChat}>
            <SquarePen /> New chat in project
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => fileRef.current?.click()}>
            <Upload /> Add files…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={first} onClick={() => onShift(-1)}>
            <ArrowUp /> Move up
          </DropdownMenuItem>
          <DropdownMenuItem disabled={last} onClick={() => onShift(1)}>
            <ArrowDown /> Move down
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            <Trash2 /> Delete project
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function HistoryItem({
  c,
  active,
  disabled,
  editing,
  onSelect,
  onRename,
  onRenameDone,
  onRenameCancel,
  onDelete,
  onMove,
}: {
  c: ConversationSummary
  active: boolean
  disabled: boolean
  editing: boolean
  onSelect: () => void
  onRename: () => void
  onRenameDone: (title: string) => void
  onRenameCancel: () => void
  onDelete: () => void
  onMove: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!editing) return
    const raf = requestAnimationFrame(() => inputRef.current?.select())
    return () => cancelAnimationFrame(raf)
  }, [editing])

  if (editing) {
    return (
      <input
        ref={inputRef}
        defaultValue={c.title}
        aria-label="Chat title"
        maxLength={120}
        className="h-8 w-full rounded-control border border-primary/60 bg-(--glass-fill) px-2 text-[13px] text-fg outline-none"
        onBlur={(e) => onRenameDone(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onRenameDone(e.currentTarget.value)
          if (e.key === 'Escape') onRenameCancel()
        }}
      />
    )
  }

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(CHAT_DRAG, c.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      className={cn(
        'group relative flex h-8 items-center rounded-control text-[13px] text-fg-70 transition-colors hover:bg-secondary hover:text-fg',
        active && 'bg-secondary font-medium text-fg'
      )}
    >
      {active && <span className="absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-full bg-primary" aria-hidden />}
      <button
        type="button"
        onClick={onSelect}
        disabled={disabled}
        aria-current={active ? 'page' : undefined}
        title={c.title}
        className="h-full min-w-0 flex-1 truncate rounded-control pr-1 pl-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      >
        {c.title}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Options for ${c.title}`}
          className={cn(
            'mr-1 grid size-6 shrink-0 place-items-center rounded-md text-fg-46 opacity-0 outline-none group-hover:opacity-100 hover:text-fg focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring data-popup-open:opacity-100 max-lg:opacity-100',
            active && 'opacity-100'
          )}
        >
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        {/* No focus hand-back to the trigger: it would blur the rename field the moment it opens. */}
        <DropdownMenuContent align="end" className="w-44" finalFocus={false}>
          <DropdownMenuItem onClick={onRename}>
            <Pencil /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onMove}>
            <FolderInput /> Move to project
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            <Trash2 /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
