'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronDown, Loader2, Maximize2, Workflow } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DiagramLegend, PipelineDiagram } from '@/components/agent/PipelineDiagram'
import type { Diagram } from '@/lib/agent/diagram'
import { cn } from '@/lib/utils'

/** The open Agent conversation, read at click time (no Suspense boundary needed). */
function currentConversationId(): string | null {
  if (typeof window === 'undefined') return null
  const c = new URLSearchParams(window.location.search).get('c')
  return c && /^[0-9a-f-]{36}$/i.test(c) ? c : null
}

/**
 * A ```flow diagram in an Agent reply, popped out as its own section: a glass
 * card that springs in, drawn top to bottom (branches spread sideways), with a
 * collapse toggle and "Open in Playground" (saves the spec, deduped, and opens
 * it full screen, left to right).
 */
export function DiagramCard({ diagram }: { diagram: Diagram }) {
  const router = useRouter()
  const [open, setOpen] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const title = diagram.title || 'Pipeline'

  async function openInPlayground() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/playground/diagrams', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec: diagram, title, source_conversation_id: currentConversationId() }),
      })
      const body = (await res.json().catch(() => ({}))) as { diagram?: { id: string } }
      if (!res.ok || !body.diagram) throw new Error(`Could not save (${res.status})`)
      router.push(`/playground?d=saved:${body.diagram.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the Playground.')
      setSaving(false)
    }
  }

  return (
    <section className="diagram-pop glass-overlay -mx-1 my-2 overflow-hidden rounded-panel" aria-label={`Pipeline diagram: ${title}`}>
      <header className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-lime/15 text-positive">
          <Workflow className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-fg">{title}</p>
          <p className="font-mono text-[10.5px] text-fg-46">
            {diagram.nodes.length} steps · {diagram.edges.length} links
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={openInPlayground} disabled={saving} aria-label="Open in Playground">
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Maximize2 className="size-3.5" />}
          <span className="max-sm:sr-only">Open in Playground</span>
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={open ? 'Collapse diagram' : 'Expand diagram'}>
          <ChevronDown className={cn('size-4 transition-transform', !open && '-rotate-90')} />
        </Button>
      </header>
      {open && (
        <div className="px-3 pt-2 pb-3">
          <PipelineDiagram diagram={diagram} direction="TB" animate />
          <DiagramLegend className="mt-2 px-1" />
        </div>
      )}
      {error && (
        <p className="border-t border-line px-4 py-2 text-[12px] text-destructive" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
