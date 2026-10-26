'use client'

import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, Loader2, Maximize2, Table2, Workflow, X } from 'lucide-react'
import { useOpenInPlayground } from '@/components/agent/DiagramCard'
import { LeadsPanel } from '@/components/agent/LeadsPanel'
import { PlaygroundCanvas } from '@/components/playground/PlaygroundCanvas'
import { Button } from '@/components/ui/button'
import { SimpleSelect } from '@/components/ui/simple-select'
import type { ChatDiagram } from '@/lib/agent/chatDiagrams'
import { placeDiagram, SPACING, type Diagram, type Direction } from '@/lib/agent/diagram'
import { cn } from '@/lib/utils'

export type SideTab = 'pipeline' | 'leads'

export interface ReviewSetRef {
  id: string
  title: string
}

/**
 * Pick the direction that lets the diagram fit the panel at the larger scale
 * (wide panels and short pipelines go left to right; tall panels and long
 * chains top to bottom). Without a diagram, fall back to the panel's shape.
 */
export function directionFor(width: number, height: number, diagram?: Pick<Diagram, 'nodes' | 'edges'> | null): Direction {
  if (!(width > 0 && height > 0)) return 'TB'
  if (!diagram?.nodes.length) return width / height >= 1.15 ? 'LR' : 'TB'
  const scale = (dir: Direction) => {
    const { ranks, breadth } = placeDiagram(diagram, dir)
    const s = SPACING[dir]
    const w = dir === 'LR' ? ranks * s.rank : breadth * s.cross
    const h = dir === 'LR' ? breadth * s.cross : ranks * s.rank
    // The canvas never zooms past 1.4, so beyond that both fit equally well.
    return Math.min(1.4, width / Math.max(w, 1), height / Math.max(h, 1))
  }
  const lr = scale('LR')
  const tb = scale('TB')
  if (Math.abs(lr - tb) <= 0.05 * Math.max(lr, tb)) return width / height >= 1.15 ? 'LR' : 'TB'
  return lr > tb ? 'LR' : 'TB'
}

function useDirection(diagram: Diagram | null) {
  const ref = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setBox({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return { ref, dir: directionFor(box.w, box.h, diagram) }
}

/**
 * The Agent's right-hand panel in split screen: the conversation's pipeline
 * diagrams (full canvas with zoom / fit / full screen, a picker when there are
 * several, Open in Playground) and the Leads tab for the active review set.
 */
export function AgentSidePanel({
  tab,
  onTab,
  diagrams,
  activeKey,
  onSelectDiagram,
  sets,
  activeSetId,
  onSelectSet,
  leadsRefresh,
  onClose,
  className,
}: {
  tab: SideTab
  onTab: (t: SideTab) => void
  diagrams: ChatDiagram[]
  activeKey: string | null
  onSelectDiagram: (key: string) => void
  sets: ReviewSetRef[]
  activeSetId: string | null
  onSelectSet: (id: string) => void
  leadsRefresh: number
  onClose: () => void
  className?: string
}) {
  const active = diagrams.find((d) => d.key === activeKey) ?? diagrams.at(-1) ?? null
  const { open: openInPlayground, saving } = useOpenInPlayground(active?.diagram ?? null)
  const { ref, dir } = useDirection(active?.diagram ?? null)
  const showTab: SideTab = tab === 'leads' && activeSetId ? 'leads' : diagrams.length ? 'pipeline' : activeSetId ? 'leads' : 'pipeline'

  const tabBtn = (t: SideTab, label: string, Icon: typeof Workflow, count: number) => (
    <button
      type="button"
      role="tab"
      aria-selected={showTab === t}
      disabled={!count}
      onClick={() => onTab(t)}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12.5px] text-fg-46 transition-colors disabled:opacity-40 max-sm:h-9 max-sm:px-3.5 max-sm:text-[13.5px]',
        showTab === t ? 'bg-primary text-primary-foreground' : 'hover:text-fg'
      )}
    >
      <Icon className="size-3.5" /> {label}
      {count > 1 && <span className="font-mono text-[10.5px] opacity-70">{count}</span>}
    </button>
  )

  return (
    <section className={cn('split-panel-in glass-overlay flex h-full min-h-0 flex-col overflow-hidden rounded-panel', className)} aria-label="Pipeline and leads">
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 max-sm:pt-[calc(env(safe-area-inset-top)+0.5rem)]">
        {/* Phones: the panel is a full-screen sheet, so lead with an explicit way back to the chat. */}
        <Button variant="ghost" size="sm" onClick={onClose} className="-ml-1 h-10 gap-1 px-2 sm:hidden" aria-label="Back to chat">
          <ChevronLeft className="size-4" /> Chat
        </Button>
        <div className="flex rounded-full border border-line p-0.5" role="tablist" aria-label="Panel view">
          {tabBtn('pipeline', 'Pipeline', Workflow, diagrams.length)}
          {tabBtn('leads', 'Leads', Table2, sets.length)}
        </div>
        {showTab === 'pipeline' && diagrams.length > 1 && (
          <SimpleSelect
            size="sm"
            aria-label="Choose diagram"
            className="max-w-56"
            value={active?.key ?? ''}
            onValueChange={onSelectDiagram}
            options={[...diagrams].reverse().map((d) => ({ value: d.key, label: d.diagram?.title || (d.streaming ? 'Drawing…' : 'Pipeline') }))}
          />
        )}
        {showTab === 'leads' && sets.length > 1 && (
          <SimpleSelect
            size="sm"
            aria-label="Choose lead set"
            className="max-w-56"
            value={activeSetId ?? ''}
            onValueChange={onSelectSet}
            options={sets.map((s) => ({ value: s.id, label: s.title }))}
          />
        )}
        <div className="flex-1" />
        {showTab === 'pipeline' && active?.diagram && (
          <Button variant="outline" size="sm" onClick={() => void openInPlayground()} disabled={saving} aria-label="Open in Playground">
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Maximize2 className="size-3.5" />}
            <span className="max-xl:sr-only">Open in Playground</span>
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close panel" className="max-sm:hidden">
          <X className="size-4" />
        </Button>
      </header>

      <div ref={ref} className="relative min-h-0 flex-1">
        {showTab === 'leads' && activeSetId ? (
          <LeadsPanel setId={activeSetId} refreshKey={leadsRefresh} />
        ) : active?.diagram ? (
          <>
            {active.diagram.title && (
              <p className="pointer-events-none absolute top-3 left-4 z-10 text-[12px] font-medium tracking-wide text-fg-46 uppercase max-sm:hidden">{active.diagram.title}</p>
            )}
            <PlaygroundCanvas key={`${active.key}:${dir}`} diagram={active.diagram} direction={dir} className="h-full rounded-none border-0 bg-transparent shadow-none" />
          </>
        ) : (
          <div className="flex h-full items-center justify-center" role="status">
            <p className="flex items-center gap-2 text-[13px] text-fg-46">
              <Loader2 className="size-4 animate-spin text-positive" /> Drawing pipeline…
            </p>
          </div>
        )}
      </div>
    </section>
  )
}
