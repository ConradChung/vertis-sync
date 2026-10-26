'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTheme } from 'next-themes'
import { MiniMap, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Maximize, Minimize, Minus, Plus, RotateCcw, Scan } from 'lucide-react'
import { buildFlow, DiagramLegend, pipeNodeTypes, STATUS } from '@/components/agent/PipelineDiagram'
import type { Diagram } from '@/lib/agent/diagram'
import { cn } from '@/lib/utils'

const FIT = { padding: 0.18, maxZoom: 1.15, duration: 400 }

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

const MINI_FILL: Record<string, string> = { done: 'var(--chart-line)', active: 'var(--chart-line)', idle: 'var(--fg-24)', unused: 'transparent' }

/**
 * Full-screen showcase canvas: left to right, wheel / pinch zoom and pan,
 * glass zoom / fit / reset / full-screen controls, minimap, hover cards.
 * Remount with a new `key` to replay the entrance when switching pipelines.
 */
export function PlaygroundCanvas({ diagram, className }: { diagram: Diagram; className?: string }) {
  const { resolvedTheme } = useTheme()
  const box = useRef<HTMLDivElement>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const { nodes, edges } = useMemo(() => buildFlow(diagram, { direction: 'LR', animate: true, hover: true }), [diagram])

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
          <MiniMap
            pannable
            zoomable
            position="top-right"
            className="!m-4 !rounded-xl !border !border-line !bg-(--glass-fill-strong) max-md:!hidden"
            maskColor="color-mix(in oklab, var(--bg) 55%, transparent)"
            nodeColor={(n) => MINI_FILL[STATUS[(n.data as { node: Diagram['nodes'][number] }).node.state]] ?? 'var(--fg-24)'}
            nodeStrokeColor="var(--fg-24)"
            nodeBorderRadius={6}
          />
          <Controls fullscreen={fullscreen} onFullscreen={toggleFullscreen} />
        </ReactFlow>
      </ReactFlowProvider>
      <div className="glass pointer-events-none absolute bottom-4 left-4 z-10 rounded-full px-3 py-1.5">
        <DiagramLegend />
      </div>
    </div>
  )
}
