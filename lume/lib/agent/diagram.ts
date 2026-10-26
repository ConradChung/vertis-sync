import { z } from 'zod'

/**
 * Inline pipeline diagrams in agent replies: a ```flow fence holding JSON
 * nodes + edges, drawn with the Campaigns Flow look. Branches are just
 * several edges out of (or into) one node. Parsing never throws.
 */

export const DIAGRAM_MAX_NODES = 30
export const DIAGRAM_MAX_EDGES = 60

export const DIAGRAM_KINDS = ['source', 'step', 'gate', 'campaign', 'cron', 'note'] as const
export const DIAGRAM_STATES = ['done', 'current', 'planned', 'skipped'] as const

const nodeSchema = z.object({
  id: z.string().trim().min(1).max(60),
  label: z.string().trim().min(1).max(60),
  detail: z.string().trim().max(160).optional(),
  kind: z.enum(DIAGRAM_KINDS).catch('step').default('step'),
  state: z.enum(DIAGRAM_STATES).catch('planned').default('planned'),
})

const edgeSchema = z.object({
  from: z.string().trim().min(1).max(60),
  to: z.string().trim().min(1).max(60),
  label: z.string().trim().max(40).optional(),
})

export const diagramSchema = z
  .object({
    title: z.string().trim().max(120).optional(),
    nodes: z.array(nodeSchema).min(1).max(DIAGRAM_MAX_NODES),
    edges: z.array(edgeSchema).max(DIAGRAM_MAX_EDGES).default([]),
  })
  .refine((d) => new Set(d.nodes.map((n) => n.id)).size === d.nodes.length, 'duplicate node ids')
  .refine((d) => {
    const ids = new Set(d.nodes.map((n) => n.id))
    return d.edges.every((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to)
  }, 'edges must connect two different existing nodes')

export type Diagram = z.infer<typeof diagramSchema>
export type DiagramNode = Diagram['nodes'][number]
export type DiagramEdge = Diagram['edges'][number]

export function parseDiagram(text: string): { ok: true; diagram: Diagram } | { ok: false; error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: 'invalid JSON' }
  }
  const r = diagramSchema.safeParse(raw)
  return r.success ? { ok: true, diagram: r.data } : { ok: false, error: r.error.issues[0]?.message ?? 'invalid diagram' }
}

export interface Placed {
  id: string
  rank: number
  /** Vertical slot, centred on 0 within its column (…, -0.5, 0, 0.5, …). */
  row: number
}

/**
 * Deterministic layout (direction-free ranks and rows). Rank = longest path
 * from a source (edges that would close a cycle are ignored), then each node
 * is pulled right to sit just before its earliest successor, so feeders and
 * feeder chains join without long edges. Rows keep the trunk straight and
 * place branches beside it (see the row pass).
 */
export function layoutDiagram(d: Pick<Diagram, 'nodes' | 'edges'>): Placed[] {
  const ids = d.nodes.map((n) => n.id)
  const order = new Map(ids.map((id, i) => [id, i]))
  const preds = new Map<string, string[]>(ids.map((id) => [id, []]))
  const succs = new Map<string, string[]>(ids.map((id) => [id, []]))
  for (const e of d.edges) {
    if (!order.has(e.from) || !order.has(e.to) || e.from === e.to) continue
    preds.get(e.to)!.push(e.from)
    succs.get(e.from)!.push(e.to)
  }

  // Kahn's algorithm for longest-path ranks.
  const indeg = new Map(ids.map((id) => [id, preds.get(id)!.length]))
  const rank = new Map<string, number>()
  const queue = ids.filter((id) => indeg.get(id) === 0)
  for (const id of queue) rank.set(id, 0)
  while (queue.length) {
    const id = queue.shift()!
    for (const s of succs.get(id)!) {
      rank.set(s, Math.max(rank.get(s) ?? 0, rank.get(id)! + 1))
      indeg.set(s, indeg.get(s)! - 1)
      if (indeg.get(s) === 0) queue.push(s)
    }
  }
  // Nodes on a cycle: place after their ranked predecessors, in input order.
  for (const id of ids) {
    if (rank.has(id)) continue
    const known = preds.get(id)!.filter((p) => rank.has(p)).map((p) => rank.get(p)! + 1)
    rank.set(id, known.length ? Math.max(...known) : 0)
  }

  // Pull every node right to sit just before its earliest successor (highest
  // ranks first, so whole feeder chains such as lead bank → cron move together
  // and join without a long edge). Longest-path ranks only ever grow here.
  const byRankDesc = [...ids].sort((x, y) => rank.get(y)! - rank.get(x)! || order.get(y)! - order.get(x)!)
  for (const id of byRankDesc) {
    const out = succs.get(id)!
    if (!out.length) continue
    const target = Math.min(...out.map((s) => rank.get(s)!)) - 1
    if (target > rank.get(id)!) rank.set(id, target)
  }

  // Rows: order each column by the mean row of its placed predecessors (fewer
  // crossings), then give each node the slot nearest that mean while keeping
  // one slot apart, and shift the column so the trunk stays straight. Columns
  // with no placed predecessors (sources) are centred.
  const maxRank = Math.max(0, ...rank.values())
  const row = new Map<string, number>()
  for (let r = 0; r <= maxRank; r++) {
    const col = ids.filter((id) => rank.get(id) === r)
    const want = (id: string): number | null => {
      const ps = preds.get(id)!.filter((p) => row.has(p))
      return ps.length ? ps.reduce((a, p) => a + row.get(p)!, 0) / ps.length : null
    }
    col.sort((a, b) => {
      const ka = want(a)
      const kb = want(b)
      if (ka !== kb) return ka === null ? 1 : kb === null ? -1 : ka - kb
      return order.get(a)! - order.get(b)!
    })
    const wanted = col.map(want)
    if (wanted.every((w) => w === null)) {
      col.forEach((id, i) => row.set(id, i - (col.length - 1) / 2))
      continue
    }
    const slots: number[] = []
    col.forEach((_, i) => {
      const w = wanted[i]
      const floor = i ? slots[i - 1] + 1 : Number.NEGATIVE_INFINITY
      slots.push(Math.max(w ?? floor, floor))
    })
    const devs = col.map((_, i) => (wanted[i] === null ? null : wanted[i]! - slots[i])).filter((d): d is number => d !== null)
    const shift = devs.reduce((a, d) => a + d, 0) / devs.length
    col.forEach((id, i) => row.set(id, slots[i] + shift))
  }
  return ids.map((id) => ({ id, rank: rank.get(id)!, row: row.get(id)! }))
}

export type Direction = 'LR' | 'TB'

/** Spacing per direction: LR = ranks are columns; TB = ranks are rows, branches spread sideways. */
export const SPACING: Record<Direction, { rank: number; cross: number }> = {
  LR: { rank: 250, cross: 112 },
  TB: { rank: 128, cross: 196 },
}

export interface Positioned extends Placed {
  x: number
  y: number
}

/**
 * Pixel positions for a direction. LR: x = rank, y = row (branches stack
 * vertically). TB: y = rank, x = row (branches spread horizontally), so the
 * chat card reads top to bottom. `ranks` / `breadth` size the canvas.
 */
export function placeDiagram(d: Pick<Diagram, 'nodes' | 'edges'>, direction: Direction = 'LR'): { placed: Positioned[]; ranks: number; breadth: number } {
  const s = SPACING[direction]
  const base = layoutDiagram(d)
  const placed = base.map((p) =>
    direction === 'LR' ? { ...p, x: p.rank * s.rank, y: p.row * s.cross } : { ...p, x: p.row * s.cross, y: p.rank * s.rank }
  )
  const ranks = Math.max(0, ...base.map((p) => p.rank)) + 1
  const rows = base.map((p) => p.row)
  // Rows can be offset from the trunk, so breadth is the span, not the busiest column.
  return { placed, ranks, breadth: Math.max(1, Math.round(Math.max(...rows) - Math.min(...rows)) + 1) }
}

/** Key-order-independent JSON, so identical specs hash the same (dedupe on save). */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v)
}
