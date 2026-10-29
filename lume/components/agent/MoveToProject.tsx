'use client'

import { Check, Folder, Inbox } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { ProjectSummary } from '@/lib/agent/projectModel'
import { cn } from '@/lib/utils'

/**
 * "Move to project": the keyboard / touch fallback for dragging a chat onto a
 * project. A list of projects plus Unfiled; the current one is marked.
 */
export function MoveToProjectDialog({
  open,
  onOpenChange,
  title,
  projects,
  current,
  onPick,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The chat's title, for the description. */
  title: string
  projects: ProjectSummary[]
  current: string | null
  onPick: (projectId: string | null) => void
}) {
  const options: { id: string | null; name: string }[] = [...projects.map((p) => ({ id: p.id, name: p.name })), { id: null, name: 'Unfiled' }]
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Move to project</DialogTitle>
          <DialogDescription className="truncate">&ldquo;{title}&rdquo;</DialogDescription>
        </DialogHeader>
        <ul className="flex max-h-[50vh] flex-col gap-0.5 overflow-y-auto" role="listbox" aria-label="Projects">
          {options.map((o) => {
            const selected = o.id === current
            const Icon = o.id ? Folder : Inbox
            return (
              <li key={o.id ?? 'unfiled'}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => {
                    onOpenChange(false)
                    if (!selected) onPick(o.id)
                  }}
                  className={cn(
                    'flex h-10 w-full items-center gap-2 rounded-control px-3 text-left text-[14px] text-fg-70 outline-none hover:bg-secondary hover:text-fg focus-visible:ring-2 focus-visible:ring-ring',
                    selected && 'bg-secondary font-medium text-fg'
                  )}
                >
                  <Icon className="size-4 shrink-0 text-fg-46" />
                  <span className="min-w-0 flex-1 truncate">{o.name}</span>
                  {selected && <Check className="size-4 text-positive" aria-label="current" />}
                </button>
              </li>
            )
          })}
        </ul>
        {projects.length === 0 && <p className="text-[13px] text-fg-46">No projects yet — create one with New project in the sidebar.</p>}
      </DialogContent>
    </Dialog>
  )
}
