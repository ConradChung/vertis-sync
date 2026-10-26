'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTheme } from 'next-themes'
import { ReactFlow, ReactFlowProvider, useReactFlow, type NodeMouseHandler } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Maximize, Minimize, Minus, Plus, RotateCcw, Scan } from 'lucide-react'
import { NodeDetails } from '@/components/agent/NodeDetails'
import { buildFlow, DiagramLegend, NODE_W, pipeNodeTypes, type PipeNode } from '@/components/agent/PipelineDiagram'
import { flowOrder, type Diagram, type Direction } from '@/lib/agent/diagram'
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

/** Steps shown on open for long pipelines; the Fit button shows them all. */
const INITIAL_FIT_NODES = 7
const INITIAL_FIT_NODES_TB = 4
/** Never open a pipeline smaller than this; pan or Fit to see the rest. */
const INITIAL_MIN_ZOOM = 0.7

/** Width the details sheet takes over the canvas (px, capped by the canvas width). */
const SHEET_W = 380

/**
 * Keeps the selected node in view beside the open details sheet: centres it in
 * the canvas area left of the sheet, at the current zoom.
 */
function FocusSelected({ id, boxWidth }: { id: string | null; boxWidth: number }) {
  const rf = useReactFlow()
  useEffect(() => {
    if (!id) return
    const n = rf.getNode(id)
    if (!n) return
    // Zoom in to a readable level when the whole pipeline was fitted small.
    const zoom = Math.max(rf.getZoom(), 0.95)
    const sheet = Math.min(SHEET_W, boxWidth * 0.9)
    const visible = Math.max(boxWidth - sheet, boxWidth * 0.35)
    // setCenter centres on the whole canvas; shift right so the node lands mid-way in the visible area.
    const offset = (boxWidth / 2 - visible / 2) / zoom
    const h = n.measured?.height ?? 80
    void rf.setCenter(n.position.x + NODE_W / 2 + offset, n.position.y + h / 2, { zoom, duration: 350 })
  }, [id, boxWidth, rf])
  return null
}

/**
 * Full-screen showcase canvas (Playground, and the Agent's pipeline panel): left to right by default, wheel / pinch zoom and pan,
 * glass zoom / fit / reset / full-screen controls, hover cards. Clicking a
 * node opens its details sheet (why, how, tools, actors, data, owner, cost,
 * risks, decisions, links) over the right of the canvas; ← / → step through
 * the flow and Esc closes. Remount with a new `key` to replay the entrance
 * when switching pipelines.
 */
export function PlaygroundCanvas({ diagram, className, direction = 'LR' }: { diagram: Diagram; className?: string; direction?: Direction }) {
  const { resolvedTheme } = useTheme()
  const box = useRef<HTMLDivElement>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [boxWidth, setBoxWidth] = useState(0)
  const flow = useMemo(() => buildFlow(diagram, { direction, animate: true, hover: true, clickable: true }), [diagram, direction])
  const nodes = useMemo<PipeNode[]>(
    // While the sheet is open: ring the selected step and turn hover previews off so they never cover the sheet.
    () => (selected ? flow.nodes.map((n) => ({ ...n, data: { ...n.data, hover: false, selected: n.id === selected } })) : flow.nodes),
    [flow.nodes, selected]
  )
  const order = useMemo(() => flowOrder(diagram), [diagram])
  // Long pipelines open on their first steps at a readable zoom (Fit shows everything).
  const initialFit = useMemo(
    () =>
      // Vertical (narrow panels) shows fewer steps up front so labels stay legible.
      order.length > (direction === 'TB' ? INITIAL_FIT_NODES_TB : INITIAL_FIT_NODES)
        ? {
            padding: FIT.padding,
            maxZoom: FIT.maxZoom,
            minZoom: INITIAL_MIN_ZOOM,
            nodes: order.slice(0, direction === 'TB' ? INITIAL_FIT_NODES_TB : INITIAL_FIT_NODES).map((id) => ({ id })),
          }
        : { padding: FIT.padding, maxZoom: FIT.maxZoom, minZoom: INITIAL_MIN_ZOOM },
    [order, direction]
  )
  const byId = useMemo(() => new Map(diagram.nodes.map((n) => [n.id, n])), [diagram])

  // Close the sheet when a different pipeline is shown (not on every re-render of the same one).
  const sig = useMemo(() => diagram.nodes.map((n) => n.id).join('|'), [diagram])
  useEffect(() => setSelected(null), [sig])

  useEffect(() => {
    const on = () => setFullscreen(document.fullscreenElement === box.current)
    document.addEventListener('fullscreenchange', on)
    return () => document.removeEventListener('fullscreenchange', on)
  }, [])

  useEffect(() => {
    const el = box.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setBoxWidth(Math.round(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen?.()
    else void box.current?.requestFullscreen?.().catch(() => {})
  }

  const onNodeClick = useCallback<NodeMouseHandler>((_e, n) => setSelected((cur) => (cur === n.id ? null : n.id)), [])
  const close = useCallback(() => setSelected(null), [])
  const at = selected ? order.indexOf(selected) : -1
  const prev = useCallback(() => at > 0 && setSelected(order[at - 1]), [at, order])
  const next = useCallback(() => at >= 0 && at < order.length - 1 && setSelected(order[at + 1]), [at, order])
  const node = selected ? byId.get(selected) : undefined

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
          edges={flow.edges}
          nodeTypes={pipeNodeTypes}
          onNodeClick={onNodeClick}
          onPaneClick={close}
          fitView
          fitViewOptions={initialFit}
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
          <FocusSelected id={selected} boxWidth={boxWidth} />
        </ReactFlow>
      </ReactFlowProvider>
      <div className="glass pointer-events-none absolute bottom-4 left-4 z-10 rounded-full px-3 py-1.5">
        <DiagramLegend />
      </div>
      {node && (
        <NodeDetails
          node={node}
          position={{ index: at + 1, total: order.length }}
          onPrev={at > 0 ? prev : null}
          onNext={at >= 0 && at < order.length - 1 ? next : null}
          onClose={close}
          // Stops above the zoom controls and legend so they stay usable.
          className="absolute top-3 right-3 bottom-[4.5rem] z-20 w-[min(380px,calc(100%-1.5rem))]"
        />
      )}
    </div>
  )
}
