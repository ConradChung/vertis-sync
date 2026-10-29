'use client'

import { Check, ChevronDown, Folder, FolderOpen, Inbox } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { ProjectSummary } from '@/lib/agent/projectModel'
import { cn } from '@/lib/utils'

/**
 * The chat header's project chip: shows the chat's project (or "No project")
 * and is the picker that moves it: a filed chat moves at once; a new chat
 * starts in the picked project. Also the mobile way to file a chat.
 */
export function ProjectChip({
  projects,
  current,
  disabled,
  onPick,
  onOpen,
}: {
  projects: ProjectSummary[]
  current: string | null
  disabled?: boolean
  onPick: (projectId: string | null) => void
  onOpen: (projectId: string) => void
}) {
  const project = projects.find((p) => p.id === current) ?? null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label={project ? `Project: ${project.name}. Move to project` : 'No project. Move to project'}
        className={cn(
          'inline-flex h-8 max-w-[11rem] max-sm:max-w-[8.5rem] items-center gap-1.5 rounded-full border px-2.5 text-[12.5px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 max-sm:h-10',
          project ? 'border-primary/50 bg-primary/10 text-fg' : 'border-line text-fg-46 hover:text-fg'
        )}
      >
        <Folder className={cn('size-3.5 shrink-0', project && 'text-positive')} />
        <span className="min-w-0 truncate">{project ? project.name : 'No project'}</span>
        <ChevronDown className="size-3 shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuGroup>
        <DropdownMenuLabel>Move to project</DropdownMenuLabel>
        {projects.map((p) => (
          <DropdownMenuItem key={p.id} onClick={() => p.id !== current && onPick(p.id)}>
            <Folder /> <span className="min-w-0 flex-1 truncate">{p.name}</span>
            {p.id === current && <Check className="text-positive" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem onClick={() => current && onPick(null)}>
          <Inbox /> <span className="flex-1">Unfiled</span>
          {!current && <Check className="text-positive" />}
        </DropdownMenuItem>
        </DropdownMenuGroup>
        {project && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onOpen(project.id)}>
              <FolderOpen /> Open project
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
