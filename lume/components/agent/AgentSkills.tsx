'use client'

import { useCallback, useEffect, useState } from 'react'
import { BookMarked, BookmarkPlus, ChevronDown, Paperclip, Pencil, Play, Settings2, Trash2, X } from 'lucide-react'
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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { describeStep, type Skill, type SkillMode } from '@/lib/agent/skillModel'
import { cn } from '@/lib/utils'

export interface SkillList {
  /** null until the first load. */
  items: Skill[] | null
  error: string | null
  reload: () => Promise<void>
  setItems: React.Dispatch<React.SetStateAction<Skill[] | null>>
}

/** The owner's saved skills; refetched when `refreshKey` changes (a run may have saved one). */
export function useSkillList(refreshKey: number): SkillList {
  const [items, setItems] = useState<Skill[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(async () => {
    try {
      const res = await fetch('/api/agent/skills', { credentials: 'same-origin' })
      if (!res.ok) throw new Error(`Could not load skills (${res.status})`)
      const body = (await res.json()) as { skills: Skill[] }
      setItems(Array.isArray(body.skills) ? body.skills : [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load skills')
      setItems((v) => v ?? [])
    }
  }, [])
  useEffect(() => {
    void reload()
  }, [reload, refreshKey])
  return { items, error, reload, setItems }
}

/** "3d ago" style, or "never". */
export function lastRunLabel(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never run'
  const mins = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000))
  if (mins < 1) return 'ran just now'
  if (mins < 60) return `ran ${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `ran ${hours}h ago`
  return `ran ${Math.round(hours / 24)}d ago`
}

const stepCount = (s: Skill) => `${s.steps.length} step${s.steps.length === 1 ? '' : 's'}`

/**
 * The Skills dropdown beside the composer: saved skills (name, description,
 * steps, last run), then "Save this chat as a skill" and "Manage skills".
 */
export function SkillMenu({
  list,
  disabled,
  canSave,
  onPick,
  onSave,
  onManage,
}: {
  list: SkillList
  disabled: boolean
  canSave: boolean
  onPick: (skill: Skill) => void
  onSave: () => void
  onManage: () => void
}) {
  const items = list.items ?? []
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label="Skills"
        className="inline-flex h-8 items-center gap-1.5 rounded-full border border-(--glass-border) bg-(--glass-fill) px-3 text-[12.5px] text-fg-70 backdrop-blur-md transition-colors outline-none hover:border-primary/50 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 data-popup-open:border-primary/60 data-popup-open:text-fg"
      >
        <BookMarked className="size-3.5" /> Skills
        {items.length > 0 && <span className="text-fg-46 tabular-nums">{items.length}</span>}
        <ChevronDown className="size-3.5 text-fg-46" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" sideOffset={8} className="w-80 max-w-[calc(100vw-2rem)]">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Saved skills</DropdownMenuLabel>
          {list.items === null ? (
            <p className="px-2 py-2 text-[12.5px] text-fg-46">Loading…</p>
          ) : items.length === 0 ? (
            <p className="px-2 py-2 text-[12.5px] leading-5 text-fg-46">
              {list.error ?? 'No skills yet. After the agent builds a pipeline, save it here to run it again.'}
            </p>
          ) : (
            <div className="max-h-72 overflow-y-auto">
              {items.map((s) => (
                <DropdownMenuItem key={s.id} onClick={() => onPick(s)} className="flex-col items-start gap-0.5 py-2">
                  <span className="w-full truncate text-[13px] font-medium text-fg">{s.name}</span>
                  {s.description && <span className="line-clamp-2 w-full text-[12px] leading-4 text-fg-46">{s.description}</span>}
                  <span className="font-mono text-[11px] text-fg-46">
                    {stepCount(s)} · {lastRunLabel(s.last_run_at)}
                  </span>
                </DropdownMenuItem>
              ))}
            </div>
          )}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onSave} disabled={!canSave}>
          <BookmarkPlus /> Save this chat as a skill
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onManage}>
          <Settings2 /> Manage skills
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The picked skill above the composer: steps and variables, then Run (the
 * agent executes it, asking for variables and actor inputs) or Reference
 * (attached to the next message as context only).
 */
export function SkillCard({
  skill,
  mode,
  busy,
  onRun,
  onReference,
  onClear,
}: {
  skill: Skill
  /** 'reference' once attached; null while still choosing. */
  mode: SkillMode | null
  busy: boolean
  onRun: () => void
  onReference: () => void
  onClear: () => void
}) {
  return (
    <section aria-label={`Skill: ${skill.name}`} className="glass mb-2 rounded-panel px-4 py-3">
      <div className="flex items-start gap-3">
        <BookMarked className="mt-0.5 size-4 shrink-0 text-positive" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h3 className="truncate text-[14px] font-semibold text-fg">{skill.name}</h3>
            <span className="shrink-0 font-mono text-[11px] text-fg-46">
              {stepCount(skill)} · {lastRunLabel(skill.last_run_at)}
            </span>
          </div>
          {skill.description && <p className="mt-0.5 text-[12.5px] leading-5 text-fg-46">{skill.description}</p>}
          <ol className="mt-2 flex flex-wrap gap-1.5" aria-label="Steps">
            {skill.steps.map((st, i) => (
              <li key={i} className="rounded-full border border-line bg-white/4 px-2.5 py-0.5 text-[11.5px] text-fg-70">
                <span className="mr-1 font-mono text-fg-46">{i + 1}</span>
                {describeStep(st)}
              </li>
            ))}
          </ol>
          {skill.variables.length > 0 && (
            <p className="mt-2 text-[12px] text-fg-46">
              Asks for:{' '}
              {skill.variables.map((v, i) => (
                <span key={v.name}>
                  {i > 0 && ', '}
                  <code className="font-mono text-fg-70">{`{{${v.name}}}`}</code>
                  {v.default ? <span className="text-fg-46"> ({v.default})</span> : null}
                </span>
              ))}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onClear}
          aria-label="Remove skill"
          className="grid size-6 shrink-0 place-items-center rounded-md text-fg-46 outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 pl-7">
        <Button size="sm" onClick={onRun} disabled={busy}>
          <Play /> Run
        </Button>
        <Button size="sm" variant="outline" onClick={onReference} disabled={busy} aria-pressed={mode === 'reference'}>
          <Paperclip /> {mode === 'reference' ? 'Attached as reference' : 'Reference'}
        </Button>
        <span className="text-[11.5px] text-fg-46">
          {mode === 'reference'
            ? 'Sent with your next message as context — nothing runs.'
            : 'Run asks for each variable and every actor’s inputs first; anything risky still waits for your approval.'}
        </span>
      </div>
    </section>
  )
}

/** Manage saved skills: rename, edit the description, read the steps, delete (with confirmation). */
export function ManageSkills({ open, onOpenChange, list }: { open: boolean; onOpenChange: (o: boolean) => void; list: SkillList }) {
  const [editing, setEditing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Skill | null>(null)
  const [deleting, setDeleting] = useState(false)
  const items = list.items ?? []

  const save = async (id: string, patch: { name?: string; description?: string }) => {
    setError(null)
    const res = await fetch(`/api/agent/skills/${id}`, {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (res.status === 409) return setError('Another skill already has that name.')
    if (!res.ok) return setError(`Could not save (${res.status}).`)
    const body = (await res.json()) as { skill: Skill }
    list.setItems((v) => v?.map((s) => (s.id === id ? body.skill : s)) ?? v)
    setEditing(null)
  }

  const remove = async () => {
    if (!confirm) return
    setDeleting(true)
    const res = await fetch(`/api/agent/skills/${confirm.id}`, { method: 'DELETE', credentials: 'same-origin' })
    setDeleting(false)
    if (!res.ok && res.status !== 404) return setError(`Could not delete (${res.status}).`)
    list.setItems((v) => v?.filter((s) => s.id !== confirm.id) ?? v)
    setConfirm(null)
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Skills</DialogTitle>
            <DialogDescription>Saved pipelines you can run again or attach as reference from the Agent tab.</DialogDescription>
          </DialogHeader>
          {error && (
            <p className="rounded-control border border-red/40 bg-red/10 px-3 py-2 text-[13px] text-red" role="alert">
              {error}
            </p>
          )}
          {items.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-fg-46">No skills yet. Ask the agent to save a pipeline once it has built one.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {items.map((s) => (
                <li key={s.id} className="rounded-panel border border-line bg-(--glass-fill) p-4">
                  {editing === s.id ? (
                    <SkillEditForm skill={s} onSave={(p) => void save(s.id, p)} onCancel={() => setEditing(null)} />
                  ) : (
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <h3 className="text-[14px] font-semibold text-fg">{s.name}</h3>
                        <p className="mt-0.5 text-[12.5px] leading-5 text-fg-46">{s.description || 'No description.'}</p>
                      </div>
                      {s.builtin ? (
                        <span className="rounded-control border border-line px-2 py-0.5 font-mono text-[11px] text-fg-46">Built-in</span>
                      ) : (
                        <>
                          <Button size="icon-sm" variant="ghost" onClick={() => setEditing(s.id)} aria-label={`Edit ${s.name}`}>
                            <Pencil />
                          </Button>
                          <Button size="icon-sm" variant="ghost" onClick={() => setConfirm(s)} aria-label={`Delete ${s.name}`} className="hover:text-red">
                            <Trash2 />
                          </Button>
                        </>
                      )}
                    </div>
                  )}
                  <ol className="mt-3 flex flex-col gap-1 text-[12.5px] text-fg-70" aria-label={`${s.name} steps`}>
                    {s.steps.map((st, i) => (
                      <li key={i} className="flex gap-2">
                        <span className="w-4 shrink-0 text-right font-mono text-fg-46">{i + 1}</span>
                        <span>{describeStep(st)}</span>
                      </li>
                    ))}
                  </ol>
                  <p className={cn('mt-3 font-mono text-[11px] text-fg-46')}>
                    {s.variables.length ? `Variables: ${s.variables.map((v) => v.name).join(', ')} · ` : ''}
                    {s.run_count} run{s.run_count === 1 ? '' : 's'} · {lastRunLabel(s.last_run_at)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && !deleting && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this skill?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{confirm?.name}&rdquo; will be removed from your skills. Campaigns and approvals it created are not affected.
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
    </>
  )
}

function SkillEditForm({ skill, onSave, onCancel }: { skill: Skill; onSave: (p: { name: string; description: string }) => void; onCancel: () => void }) {
  const [name, setName] = useState(skill.name)
  const [description, setDescription] = useState(skill.description)
  const field =
    'w-full rounded-control border border-(--glass-border) bg-(--glass-fill) px-3 py-2 text-[13px] text-fg outline-none focus:border-primary/60'
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (name.trim()) onSave({ name: name.trim(), description: description.trim() })
      }}
    >
      <label className="text-[11px] font-medium tracking-[0.06em] text-fg-46 uppercase" htmlFor={`skill-name-${skill.id}`}>
        Name
      </label>
      <input id={`skill-name-${skill.id}`} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} className={cn(field, 'h-9')} autoFocus />
      <label className="text-[11px] font-medium tracking-[0.06em] text-fg-46 uppercase" htmlFor={`skill-desc-${skill.id}`}>
        Description
      </label>
      <textarea
        id={`skill-desc-${skill.id}`}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        maxLength={1000}
        rows={2}
        className={cn(field, 'resize-none')}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!name.trim()}>
          Save
        </Button>
      </div>
    </form>
  )
}
