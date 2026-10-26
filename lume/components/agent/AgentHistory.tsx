'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MoreHorizontal, Pencil, SquarePen, Trash2 } from 'lucide-react'
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { groupConversations, type ConversationSummary } from '@/lib/agent/history'
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

export interface AgentHistoryProps {
  list: ConversationList
  activeId: string | null
  /** A run is live: switching away is blocked until it ends. */
  busy: boolean
  onSelect: (id: string) => void
  onNew: () => void
  /** The active conversation was deleted. */
  onDeletedActive: () => void
  className?: string
}

/**
 * The Agent tab's conversation list: New chat, then conversations grouped
 * Today / Yesterday / Previous 7 days / Older, each with rename and delete
 * (delete asks first, and is a soft delete on the server).
 */
export function AgentHistory({ list, activeId, busy, onSelect, onNew, onDeletedActive, className }: AgentHistoryProps) {
  const { items, error, setItems, setError } = list
  const [renaming, setRenaming] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConversationSummary | null>(null)
  const [deleting, setDeleting] = useState(false)

  const groups = useMemo(() => groupConversations(items ?? []), [items])

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

  return (
    <nav aria-label="Chat history" className={cn('flex min-h-0 flex-col', className)}>
      <Button variant="outline" className="h-9 w-full justify-start gap-2" onClick={onNew} disabled={busy}>
        <SquarePen className="size-4" /> New chat
      </Button>

      <div className="-mx-1 mt-4 min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {items === null ? (
          <div className="flex flex-col gap-2" aria-label="Loading history">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-8 w-full rounded-control" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <p className="px-2 text-[13px] leading-5 text-fg-46">{error ?? 'No conversations yet. Chats you start are saved here.'}</p>
        ) : (
          groups.map((g) => (
            <section key={g.label} className="mb-4">
              <h3 className="mb-1 px-2 text-[11px] font-medium tracking-[0.06em] text-fg-46 uppercase">{g.label}</h3>
              <ul className="flex flex-col gap-0.5">
                {g.items.map((c) => (
                  <li key={c.id}>
                    <HistoryItem
                      c={c}
                      active={c.id === activeId}
                      disabled={busy && c.id !== activeId}
                      editing={renaming === c.id}
                      onSelect={() => onSelect(c.id)}
                      onRename={() => setRenaming(c.id)}
                      onRenameDone={(t) => void rename(c.id, t)}
                      onRenameCancel={() => setRenaming(null)}
                      onDelete={() => setConfirm(c)}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
        {error && items && items.length > 0 && (
          <p className="px-2 text-[12px] text-red" role="alert">
            {error}
          </p>
        )}
      </div>

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
    </nav>
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
            'mr-1 grid size-6 shrink-0 place-items-center rounded-md text-fg-46 opacity-0 outline-none group-hover:opacity-100 hover:text-fg focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring data-popup-open:opacity-100',
            active && 'opacity-100'
          )}
        >
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        {/* No focus hand-back to the trigger: it would blur the rename field the moment it opens. */}
        <DropdownMenuContent align="end" className="w-36" finalFocus={false}>
          <DropdownMenuItem onClick={onRename}>
            <Pencil /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            <Trash2 /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
