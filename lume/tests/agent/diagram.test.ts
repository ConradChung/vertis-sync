import { describe, expect, it } from 'vitest'
import { DIAGRAM_MAX_NODES, layoutDiagram, parseDiagram } from '@/lib/agent/diagram'

const sample = {
  title: 'Kaspen',
  nodes: [
    { id: 'apify', label: 'Google Maps', kind: 'source', state: 'planned' },
    { id: 'lf', label: 'Leadsfriday', kind: 'source', state: 'done' },
    { id: 'val', label: 'Validate', kind: 'step', state: 'current' },
    { id: 'push', label: 'Push gate', kind: 'gate' },
    { id: 'main', label: 'Kaspen', kind: 'campaign' },
    { id: 'noloc', label: 'No Location', kind: 'campaign', state: 'skipped' },
  ],
  edges: [
    { from: 'apify', to: 'val' },
    { from: 'lf', to: 'val' },
    { from: 'val', to: 'push' },
    { from: 'push', to: 'main', label: 'has city' },
    { from: 'push', to: 'noloc', label: 'no city' },
  ],
}

describe('parseDiagram', () => {
  it('accepts a valid diagram and fills defaults', () => {
    const r = parseDiagram(JSON.stringify(sample))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.diagram.nodes.find((n) => n.id === 'push')).toMatchObject({ kind: 'gate', state: 'planned' })
  })

  it('coerces unknown kinds/states instead of failing', () => {
    const r = parseDiagram(JSON.stringify({ nodes: [{ id: 'a', label: 'A', kind: 'robot', state: 'weird' }] }))
    expect(r.ok && r.diagram.nodes[0]).toMatchObject({ kind: 'step', state: 'planned' })
  })

  it('rejects invalid JSON (e.g. still streaming)', () => {
    expect(parseDiagram('{"nodes": [{"id": "a"').ok).toBe(false)
  })

  it('rejects edges to unknown nodes and duplicate ids', () => {
    expect(parseDiagram(JSON.stringify({ nodes: [{ id: 'a', label: 'A' }], edges: [{ from: 'a', to: 'b' }] })).ok).toBe(false)
    expect(parseDiagram(JSON.stringify({ nodes: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] })).ok).toBe(false)
  })

  it('rejects oversized diagrams', () => {
    const nodes = Array.from({ length: DIAGRAM_MAX_NODES + 1 }, (_, i) => ({ id: `n${i}`, label: `N${i}` }))
    expect(parseDiagram(JSON.stringify({ nodes })).ok).toBe(false)
  })
})

describe('layoutDiagram', () => {
  const placed = Object.fromEntries(layoutDiagram(parseDiagramOk()).map((p) => [p.id, p]))

  function parseDiagramOk() {
    const r = parseDiagram(JSON.stringify(sample))
    if (!r.ok) throw new Error('bad sample')
    return r.diagram
  }

  it('ranks by longest path from the sources', () => {
    expect([placed.apify.rank, placed.lf.rank, placed.val.rank, placed.push.rank, placed.main.rank, placed.noloc.rank]).toEqual([0, 0, 1, 2, 3, 3])
  })

  it('gives merging sources and split branches distinct rows, centred on the trunk', () => {
    expect(placed.apify.row).not.toBe(placed.lf.row)
    expect(placed.main.row).not.toBe(placed.noloc.row)
    expect(placed.val.row).toBe(0)
    expect(placed.apify.row + placed.lf.row).toBe(0)
  })

  it('uses the longest path when a feeder skips ahead', () => {
    const p = Object.fromEntries(
      layoutDiagram({
        nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'cron' }].map((n) => ({ ...n, label: n.id, kind: 'step' as const, state: 'planned' as const })),
        edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'a', to: 'c' }, { from: 'cron', to: 'c' }],
      }).map((x) => [x.id, x])
    )
    expect(p.c.rank).toBe(2)
    // A feeder sits one column before where it joins.
    expect(p.cron.rank).toBe(1)
    expect(p.cron.row).not.toBe(p.b.row)
  })

  it('survives cycles deterministically', () => {
    const nodes = ['a', 'b'].map((id) => ({ id, label: id, kind: 'step' as const, state: 'planned' as const }))
    const out = layoutDiagram({ nodes, edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] })
    expect(out).toHaveLength(2)
    expect(layoutDiagram({ nodes, edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] })).toEqual(out)
  })
})
