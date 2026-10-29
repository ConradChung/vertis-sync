'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useFileDropGuard } from '@/hooks/useFileDropGuard'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, FileText, FolderOpen, Image as ImageIcon, Loader2, MessageSquare, NotebookPen, SquarePen, Trash2, Upload } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button, buttonVariants } from '@/components/ui/button'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { addNote, deleteItem, deleteProject, dragKind, patchProject, uploadProjectFiles } from '@/lib/agent/projectClient'
import { ACCEPT, formatBytes, INSTRUCTIONS_MAX, MAX_PROJECT_BYTES, type Project, type ProjectItem } from '@/lib/agent/projectModel'
import type { ConversationSummary } from '@/lib/agent/history'
import { cn } from '@/lib/utils'

interface Loaded {
  project: Project
  items: ProjectItem[]
  conversations: ConversationSummary[]
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

/** Autosave delay for the instructions editor. */
export const AUTOSAVE_MS = 800

/**
 * `/agent/projects/<id>`: one project's knowledge. Instructions (autosaved),
 * the linked vertical, files and notes (drop files anywhere on the drop zone,
 * or browse; add a note), the project's chats, and "New chat in project".
 */
export function ProjectView({ id }: { id: string }) {
  const router = useRouter()
  const [data, setData] = useState<Loaded | null>(null)
  const [missing, setMissing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [instructions, setInstructions] = useState('')
  const [save, setSave] = useState<SaveState>('idle')
  const [verticals, setVerticals] = useState<{ id: string; name: string }[]>([])
  const [over, setOver] = useState(false)
  const [uploading, setUploading] = useState(0)
  const [note, setNote] = useState('')
  const [confirm, setConfirm] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSaved = useRef('')
  // The latest text, for the unmount flush (state is stale in a cleanup).
  const latest = useRef('')
  useFileDropGuard()
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/agent/projects/${id}`, { credentials: 'same-origin' })
      if (res.status === 404 || res.status === 400) return setMissing(true)
      if (!res.ok) throw new Error(`Could not load this project (${res.status}).`)
      const body = (await res.json()) as Loaded
      setData(body)
      return body
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this project.')
    }
  }, [id])

  useEffect(() => {
    void load().then((b) => {
      if (!b) return
      setInstructions(b.project.instructions)
      lastSaved.current = b.project.instructions
      latest.current = b.project.instructions
    })
  }, [load])

  useEffect(() => {
    fetch('/api/verticals', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : { verticals: [] }))
      .then((b: { verticals?: { id: string; name: string }[] }) => setVerticals(Array.isArray(b.verticals) ? b.verticals : []))
      .catch(() => {})
  }, [])

  const persist = useCallback(
    async (text: string) => {
      if (text === lastSaved.current) return setSave('saved')
      setSave('saving')
      const r = await patchProject(id, { instructions: text })
      if (r.ok) {
        lastSaved.current = text
        setSave('saved')
      } else {
        setSave('error')
        setError(r.error)
      }
    },
    [id]
  )

  // Autosave: a pause in typing saves; leaving the page flushes.
  const onInstructions = (text: string) => {
    setInstructions(text)
    latest.current = text
    setSave('idle')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      void persist(text)
    }, AUTOSAVE_MS)
  }
  // Leaving with a save still pending (navigating away mid-typing) sends it now.
  useEffect(
    () => () => {
      if (!timer.current) return
      clearTimeout(timer.current)
      timer.current = null
      if (latest.current !== lastSaved.current) void patchProject(id, { instructions: latest.current }, { keepalive: true })
    },
    [id]
  )

  const rename = async (name: string) => {
    const n = name.trim()
    if (!data || !n || n === data.project.name) return
    const r = await patchProject(id, { name: n })
    if (r.ok) setData((d) => (d ? { ...d, project: r.project } : d))
    else setError(r.error)
  }

  const linkVertical = async (verticalId: string) => {
    const r = await patchProject(id, { vertical_id: verticalId || null })
    if (r.ok) setData((d) => (d ? { ...d, project: r.project } : d))
    else setError(r.error)
  }

  const addFiles = async (files: File[]) => {
    if (!files.length) return
    setUploading((n) => n + files.length)
    const { added, errors } = await uploadProjectFiles(id, files)
    setUploading((n) => Math.max(0, n - files.length))
    if (added.length) setData((d) => (d ? { ...d, items: [...added, ...d.items] } : d))
    setError(errors.length ? errors.join(' · ') : null)
  }

  const saveNote = async () => {
    const text = note.trim()
    if (!text) return
    const r = await addNote(id, text)
    if (!r.ok) return setError(r.error)
    setNote('')
    setData((d) => (d ? { ...d, items: [r.item, ...d.items] } : d))
  }

  const removeItem = async (item: ProjectItem) => {
    const prev = data
    setData((d) => (d ? { ...d, items: d.items.filter((i) => i.id !== item.id) } : d))
    const r = await deleteItem(id, item.id)
    if (!r.ok) {
      setData(prev)
      setError(r.error)
    }
  }

  const remove = async () => {
    setConfirm(false)
    const r = await deleteProject(id)
    if (r.ok) router.push('/agent')
    else setError(r.error)
  }

  if (missing) {
    return (
      <div className="glass mx-auto flex max-w-xl flex-col items-center rounded-panel p-10 text-center" role="status">
        <FolderOpen className="size-6 text-fg-46" />
        <h1 className="mt-3 text-[18px] font-semibold text-fg">This project isn&apos;t here</h1>
        <p className="mt-1 text-[14px] text-fg-46">It was deleted, or the link is wrong.</p>
        <Link href="/agent" className={cn(buttonVariants(), 'mt-5')}>
          Back to Agent
        </Link>
      </div>
    )
  }
  if (!data) {
    return (
      <div className="mx-auto flex max-w-[1100px] flex-col gap-4" aria-label="Loading project">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-48 w-full rounded-panel" />
        {error && (
          <p className="text-[13px] text-red" role="alert">
            {error}
          </p>
        )}
      </div>
    )
  }

  const { project, items, conversations } = data
  const used = items.reduce((s, i) => s + i.size_bytes, 0)
  const verticalOptions = [{ value: '', label: 'No vertical' }, ...verticals.map((v) => ({ value: v.id, label: v.name }))]

  return (
    <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <Link href="/agent" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
          <ArrowLeft className="size-4" /> Agent
        </Link>
        <input
          key={project.name}
          defaultValue={project.name}
          aria-label="Project name"
          maxLength={80}
          className="min-w-0 flex-1 rounded-control bg-transparent px-2 py-1 text-[24px] font-semibold tracking-[-0.5px] text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onBlur={(e) => void rename(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        <Link href={`/agent?project=${project.id}`} className={cn(buttonVariants(), 'gap-1.5 px-3')}>
          <SquarePen className="size-4" /> New chat in project
        </Link>
        <Button variant="ghost" size="icon" aria-label="Delete project" onClick={() => setConfirm(true)}>
          <Trash2 className="size-4" />
        </Button>
      </div>

      {error && (
        <p className="rounded-control border border-red/40 bg-red/10 px-3 py-2 text-[13px] text-red" role="alert">
          {error}
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <section className="glass rounded-panel p-4 sm:p-5" aria-labelledby="pi-title">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 id="pi-title" className="text-[14px] font-semibold text-fg">
                Instructions
              </h2>
              <span className={cn('text-[12px]', save === 'error' ? 'text-red' : 'text-fg-46')} role="status" aria-live="polite">
                {save === 'saving' ? 'Saving…' : save === 'saved' ? 'Saved' : save === 'error' ? "Couldn't save" : ''}
              </span>
            </div>
            <Textarea
              aria-label="Project instructions"
              value={instructions}
              maxLength={INSTRUCTIONS_MAX}
              onChange={(e) => onInstructions(e.target.value)}
              onBlur={() => {
                if (timer.current) clearTimeout(timer.current)
                void persist(instructions)
              }}
              placeholder="e.g. Roofers in Austin. Never order more than 2k leads. Tone: casual."
              className="min-h-40 text-[14px] leading-6"
            />
            <p className="mt-2 text-[12px] text-fg-46">Lume follows these in every chat in this project.</p>
          </section>

          <section className="glass rounded-panel p-4 sm:p-5" aria-labelledby="pv-title">
            <h2 id="pv-title" className="mb-2 text-[14px] font-semibold text-fg">
              Linked vertical
            </h2>
            <SimpleSelect aria-label="Linked vertical" value={project.vertical_id ?? ''} onValueChange={(v) => void linkVertical(v)} options={verticalOptions} />
            <p className="mt-2 text-[12px] text-fg-46">
              Chats its Grok Bot starts, or that you open from its /operator page, are filed here automatically. A vertical links to one project.
            </p>
          </section>

          <section className="glass rounded-panel p-4 sm:p-5" aria-labelledby="pc-title">
            <h2 id="pc-title" className="mb-2 text-[14px] font-semibold text-fg">
              Chats
            </h2>
            {conversations.length === 0 ? (
              <p className="text-[13px] text-fg-46">No chats yet. Start one, or drag chats onto this project in the sidebar.</p>
            ) : (
              <ul className="flex flex-col gap-0.5" aria-label="Project chats">
                {conversations.map((c) => (
                  <li key={c.id}>
                    <Link
                      href={`/agent?c=${c.id}`}
                      className="flex h-9 items-center gap-2 rounded-control px-2 text-[13px] text-fg-70 hover:bg-secondary hover:text-fg"
                    >
                      <MessageSquare className="size-3.5 shrink-0 text-fg-46" />
                      <span className="min-w-0 flex-1 truncate">{c.title}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <section className="glass flex min-w-0 flex-col gap-4 rounded-panel p-4 sm:p-5" aria-labelledby="pk-title">
          <div className="flex items-center justify-between gap-2">
            <h2 id="pk-title" className="text-[14px] font-semibold text-fg">
              Files and notes
            </h2>
            <span className="text-[12px] text-fg-46 tabular-nums">
              {formatBytes(used)} of {formatBytes(MAX_PROJECT_BYTES)}
            </span>
          </div>

          <div
            data-testid="project-drop-zone"
            role="button"
            tabIndex={0}
            aria-label="Add files: drop them here or press to browse"
            onClick={() => fileRef.current?.click()}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), fileRef.current?.click())}
            onDragOver={(e) => {
              if (dragKind(e.dataTransfer) !== 'files') return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'copy'
              if (!over) setOver(true)
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
            }}
            onDrop={(e) => {
              setOver(false)
              if (dragKind(e.dataTransfer) !== 'files') return
              e.preventDefault()
              void addFiles(Array.from(e.dataTransfer.files ?? []))
            }}
            className={cn(
              'flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-panel border border-dashed border-line px-4 py-7 text-center outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
              over ? 'border-primary bg-primary/10' : 'hover:border-primary/50'
            )}
          >
            {uploading ? <Loader2 className="size-5 animate-spin text-positive" /> : <Upload className={cn('size-5', over ? 'text-positive' : 'text-fg-46')} />}
            <p className="text-[13px] text-fg">{uploading ? `Uploading ${uploading} file${uploading === 1 ? '' : 's'}…` : 'Drop files here, or click to browse'}</p>
            <p className="text-[12px] text-fg-46">CSV, PDF, MD, TXT, JSON or images · up to 20 MB each</p>
          </div>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept={ACCEPT}
            className="hidden"
            aria-label="Choose files"
            onChange={(e) => {
              void addFiles(Array.from(e.currentTarget.files ?? []))
              e.currentTarget.value = ''
            }}
          />

          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void saveNote()
            }}
          >
            <Textarea aria-label="New note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note: a fact, a rule, a snippet…" className="min-h-20 text-[13px]" />
            <Button type="submit" variant="outline" size="sm" className="self-end" disabled={!note.trim()}>
              <NotebookPen className="size-3.5" /> Add note
            </Button>
          </form>

          {items.length === 0 ? (
            <p className="text-[13px] text-fg-46">Nothing yet. Files and notes here are given to Lume in every chat in this project.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line" aria-label="Project files and notes">
              {items.map((i) => {
                const image = (i.mime ?? '').startsWith('image/')
                const Icon = i.kind === 'note' ? NotebookPen : image ? ImageIcon : FileText
                return (
                  <li key={i.id} className="flex items-center gap-2 py-2">
                    <Icon className="size-4 shrink-0 text-fg-46" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] text-fg" title={i.name}>
                        {i.name}
                      </p>
                      <p className="text-[11.5px] text-fg-46">
                        {i.kind === 'note' ? 'Note' : formatBytes(i.size_bytes)}
                        {i.kind === 'file' && image && ' · image, listed by name'}
                        {i.kind === 'file' && !image && !i.readable && <span className="text-red"> · not readable</span>}
                        {i.truncated && ' · truncated'}
                      </p>
                    </div>
                    <Button variant="ghost" size="icon-sm" aria-label={`Delete ${i.name}`} onClick={() => void removeItem(i)}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this project?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{project.name}&rdquo; and its files and notes will be deleted. Its chats move to Unfiled; none are deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button variant="destructive" onClick={() => void remove()}>
              Delete project
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
