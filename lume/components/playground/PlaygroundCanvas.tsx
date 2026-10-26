'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTheme } from 'next-themes'
import { ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Maximize, Minimize, Minus, Plus, RotateCcw, Scan } from 'lucide-react'
import { buildFlow, DiagramLegend, pipeNodeTypes } from '@/components/agent/PipelineDiagram'
import type { Diagram, Direction } from '@/lib/agent/diagram'
import { cn } from '@/lib/utils'

const FIT = { padding: 0.16, maxZoom: 1.4, duration: 400 }

function ControlButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex size-8 items-center justify-center rounded-full text-fg-70 transition-colors hover:bg-white/10 hover:text-fg focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:outline-none light:hover:bg-black/5"
    >
      {children}
    </button>
  )
}

function Controls({ fullscreen, onFullscreen }: { fullscreen: boolean; onFullscreen: () => void }) {
  const rf = useReactFlow()
  return (
    <div className="glass absolute right-4 bottom-4 z-10 flex items-center gap-0.5 rounded-full p-1" role="toolbar" aria-label="Diagram controls">
      <ControlButton label="Zoom out" onClick={() => rf.zoomOut({ duration: 200 })}>
        <Minus className="size-4" />
      </ControlButton>
      <ControlButton label="Zoom in" onClick={() => rf.zoomIn({ duration: 200 })}>
        <Plus className="size-4" />
      </ControlButton>
      <ControlButton label="Fit to screen" onClick={() => rf.fitView(FIT)}>
        <Scan className="size-4" />
      </ControlButton>
      <ControlButton
        label="Reset view"
        onClick={() => {
          rf.setViewport({ x: 0, y: 0, zoom: 1 })
          requestAnimationFrame(() => rf.fitView(FIT))
        }}
      >
        <RotateCcw className="size-4" />
      </ControlButton>
      <span className="mx-1 h-5 w-px bg-line" aria-hidden />
      <ControlButton label={fullscreen ? 'Exit full screen' : 'Full screen'} onClick={onFullscreen}>
        {fullscreen ? <Minimize className="size-4" /> : <Maximize className="size-4" />}
      </ControlButton>
    </div>
  )
}

/**
 * Full-screen showcase canvas (Playground, and the Agent's pipeline panel): left to right by default, wheel / pinch zoom and pan,
 * glass zoom / fit / reset / full-screen controls, hover cards.
 * Remount with a new `key` to replay the entrance when switching pipelines.
 */
export function PlaygroundCanvas({ diagram, className, direction = 'LR' }: { diagram: Diagram; className?: string; direction?: Direction }) {
  const { resolvedTheme } = useTheme()
  const box = useRef<HTMLDivElement>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const { nodes, edges } = useMemo(() => buildFlow(diagram, { direction, animate: true, hover: true }), [diagram, direction])

  useEffect(() => {
    const on = () => setFullscreen(document.fullscreenElement === box.current)
    document.addEventListener('fullscreenchange', on)
    return () => document.removeEventListener('fullscreenchange', on)
  }, [])

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen?.()
    else void box.current?.requestFullscreen?.().catch(() => {})
  }

  return (
    <div
      ref={box}
      className={cn('diagram-switch glass-overlay relative overflow-hidden rounded-panel', fullscreen && 'rounded-none bg-(--bg)', className)}
      aria-label={diagram.title ? `Pipeline: ${diagram.title}` : 'Pipeline'}
      role="figure"
    >
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={pipeNodeTypes}
          fitView
          fitViewOptions={{ padding: FIT.padding, maxZoom: FIT.maxZoom }}
          minZoom={0.2}
          maxZoom={2.5}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          zoomOnScroll
          zoomOnPinch
          panOnDrag
          proOptions={{ hideAttribution: true }}
          colorMode={resolvedTheme === 'light' ? 'light' : 'dark'}
          style={{ background: 'transparent' }}
        >
          <Controls fullscreen={fullscreen} onFullscreen={toggleFullscreen} />
        </ReactFlow>
      </ReactFlowProvider>
      <div className="glass pointer-events-none absolute bottom-4 left-4 z-10 rounded-full px-3 py-1.5">
        <DiagramLegend />
      </div>
    </div>
  )
}
