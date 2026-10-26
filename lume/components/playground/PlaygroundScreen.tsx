'use client'

import { useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import useSWR from 'swr'
import { Pencil, Trash2, Workflow } from 'lucide-react'
import { fetchJson } from '@/hooks/fetcher'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PlaygroundCanvas } from '@/components/playground/PlaygroundCanvas'
import type { Diagram } from '@/lib/agent/diagram'
import type { Skill } from '@/lib/agent/skillModel'
import type { CampaignFlowResponse, CampaignTableResponse } from '@/lib/campaigns/types'
import { buildCatalog, pickInitial } from '@/lib/playground/catalog'
import { flowToDiagram, skillToDiagram } from '@/lib/playground/convert'
import { parseRef, refKey, type PlaygroundRef, type SavedDiagram } from '@/lib/playground/model'

const opts = { revalidateOnFocus: false }

/** Resolve the selected entry to a diagram (saved spec, converted flow or skill). */
function useSelectedDiagram(ref: PlaygroundRef | null, saved: SavedDiagram[] | undefined, skills: Skill[] | undefined) {
  const listedSaved = ref?.kind === 'saved' ? saved?.find((d) => d.id === ref.id) : undefined
  const savedOne = useSWR<{ diagram: SavedDiagram }>(ref?.kind === 'saved' && saved && !listedSaved ? `/api/playground/diagrams/${ref.id}` : null, fetchJson, opts)
  const flow = useSWR<CampaignFlowResponse>(ref?.kind === 'campaign' ? `/api/campaigns/${ref.id}/flow` : null, fetchJson, opts)
  return useMemo((): { diagram: Diagram | null; loading: boolean; error: string | null } => {
    if (!ref) return { diagram: null, loading: false, error: null }
    if (ref.kind === 'saved') {
      const d = listedSaved ?? savedOne.data?.diagram
      if (d) return { diagram: { ...d.spec, title: d.title }, loading: false, error: null }
      return { diagram: null, loading: !saved || savedOne.isLoading, error: savedOne.error ? 'This saved diagram was deleted or could not be loaded.' : null }
    }
    if (ref.kind === 'skill') {
      const s = skills?.find((x) => x.id === ref.id)
      if (s) return { diagram: skillToDiagram(s), loading: false, error: null }
      return { diagram: null, loading: !skills, error: skills ? 'This skill no longer exists.' : null }
    }
    if (flow.data) return { diagram: flowToDiagram(flow.data), loading: false, error: null }
    return { diagram: null, loading: flow.isLoading, error: flow.error ? 'Could not load this campaign flow.' : null }
  }, [ref, listedSaved, savedOne.data, savedOne.isLoading, savedOne.error, saved, skills, flow.data, flow.isLoading, flow.error])
}

/**
 * Playground: showcase any pipeline full screen — diagrams saved from Agent
 * chats, every Instantly campaign's live Flow, and saved skills. The pick
 * lives in `?d=<kind>:<id>` so a link opens straight to it.
 */
export function PlaygroundScreen() {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const savedSwr = useSWR<{ diagrams: SavedDiagram[] }>('/api/playground/diagrams', fetchJson, opts)
  const skillsSwr = useSWR<{ skills: Skill[] }>('/api/agent/skills', fetchJson, opts)
  const campaignsSwr = useSWR<CampaignTableResponse>('/api/campaigns?with=analytics', fetchJson, opts)

  const groups = useMemo(
    () => buildCatalog({ saved: savedSwr.data?.diagrams, campaigns: campaignsSwr.data?.campaigns, skills: skillsSwr.data?.skills }),
    [savedSwr.data, campaignsSwr.data, skillsSwr.data]
  )
  const catalogLoading = !savedSwr.data && !savedSwr.error && !skillsSwr.data && !campaignsSwr.data
  const selected = pickInitial(groups, parseRef(params.get('d')))
  const { diagram, loading, error } = useSelectedDiagram(selected, savedSwr.data?.diagrams, skillsSwr.data?.skills)

  const select = (key: string) => {
    const next = new URLSearchParams(params.toString())
    next.set('d', key)
    router.replace(`${pathname}?${next.toString()}`, { scroll: false })
  }

  const items = groups.flatMap((g) => g.items.map((i) => ({ value: i.key, label: i.label })))
  const selectedKey = selected ? refKey(selected) : null
  // A saved diagram opened from chat may not be in the list yet: still show its title in the trigger.
  if (selectedKey && diagram && !items.some((i) => i.value === selectedKey)) items.push({ value: selectedKey, label: diagram.title ?? 'Pipeline' })
  const savedSelected = selected?.kind === 'saved' ? selected.id : null

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] tracking-[0.18em] text-fg-46 uppercase">Showcase</p>
          <h1 className="text-[26px] font-semibold tracking-tight text-fg">Playground</h1>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          {catalogLoading ? (
            <Skeleton className="h-9 w-72 rounded-control" />
          ) : (
            <Select items={items} value={selectedKey} onValueChange={(v) => v && select(String(v))}>
              <SelectTrigger aria-label="Pipeline" className="glass w-[min(22rem,80vw)] text-[13px]">
                <Workflow className="size-3.5 text-fg-46" />
                <SelectValue placeholder="Choose a pipeline" />
              </SelectTrigger>
              <SelectContent className="glass-overlay max-h-96 w-auto min-w-(--anchor-width)">
                {groups.map((g) => (
                  <SelectGroup key={g.kind}>
                    <SelectLabel className="tracking-wide uppercase">{g.label}</SelectLabel>
                    {g.items.map((i) => (
                      <SelectItem key={i.key} value={i.key}>
                        <span className="truncate">{i.label}</span>
                        <span className="ml-auto pl-3 font-mono text-[10.5px] text-fg-46">{i.hint}</span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          )}
          {savedSelected && diagram && (
            <SavedActions
              id={savedSelected}
              title={diagram.title ?? ''}
              onChanged={() => void savedSwr.mutate()}
              onDeleted={() => {
                void savedSwr.mutate()
                router.replace(pathname, { scroll: false })
              }}
            />
          )}
        </div>
      </div>

      <div className="h-[calc(100dvh-var(--topbar-h)-11rem)] min-h-[420px]">
        {diagram ? (
          <PlaygroundCanvas key={selectedKey} diagram={diagram} className="h-full" />
        ) : loading || catalogLoading ? (
          <Skeleton className="h-full w-full rounded-panel" />
        ) : (
          <div className="glass-overlay flex h-full flex-col items-center justify-center gap-2 rounded-panel p-6 text-center">
            <Workflow className="size-6 text-fg-46" />
            <p className="font-medium text-fg">{error ?? 'No pipelines yet'}</p>
            <p className="max-w-md text-[13px] text-fg-46">
              {error
                ? 'Pick another pipeline from the menu.'
                : 'Ask the Agent to brainstorm a pipeline and press "Open in Playground" on its diagram, or save a skill. Campaign flows appear here once Instantly is connected.'}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function SavedActions({ id, title, onChanged, onDeleted }: { id: string; title: string; onChanged: () => void; onDeleted: () => void }) {
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [draft, setDraft] = useState(title)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function call(method: 'PATCH' | 'DELETE', body?: unknown) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/playground/diagrams/${id}`, {
        method,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      if (!res.ok) throw new Error(`Failed (${res.status})`)
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed')
      return false
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button
        variant="outline"
        size="icon-sm"
        aria-label="Rename diagram"
        onClick={() => {
          setDraft(title)
          setRenaming(true)
        }}
      >
        <Pencil className="size-3.5" />
      </Button>
      <Button variant="outline" size="icon-sm" aria-label="Delete diagram" onClick={() => setDeleting(true)}>
        <Trash2 className="size-3.5" />
      </Button>

      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename diagram</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={async (e) => {
              e.preventDefault()
              if (!draft.trim()) return
              if (await call('PATCH', { title: draft.trim() })) {
                setRenaming(false)
                onChanged()
              }
            }}
            className="flex flex-col gap-3"
          >
            <Input value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={120} aria-label="Diagram name" autoFocus />
            {error && <p className="text-[12px] text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="submit" disabled={busy || !draft.trim()}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{title}”?</AlertDialogTitle>
            <AlertDialogDescription>It disappears from the Playground. The chat it came from keeps its diagram.</AlertDialogDescription>
          </AlertDialogHeader>
          {error && <p className="text-[12px] text-destructive">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                if (await call('DELETE')) {
                  setDeleting(false)
                  onDeleted()
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
