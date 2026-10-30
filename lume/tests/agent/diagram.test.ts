import { describe, expect, it } from 'vitest'
import { canonicalJson, DIAGRAM_MAX_NODES, layoutDiagram, parseDiagram, placeDiagram } from '@/lib/agent/diagram'
import { chatDiagrams } from '@/lib/agent/chatDiagrams'

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

describe('placeDiagram directions', () => {
  const d = {
    nodes: [
      { id: 'a', label: 'A', kind: 'source' as const, state: 'done' as const },
      { id: 'b', label: 'B', kind: 'step' as const, state: 'done' as const },
      { id: 'c', label: 'C', kind: 'campaign' as const, state: 'planned' as const },
      { id: 'd', label: 'D', kind: 'campaign' as const, state: 'planned' as const },
    ],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'b', to: 'd' },
    ],
  }

  it('LR puts ranks on x and branches on y', () => {
    const { placed, ranks, breadth } = placeDiagram(d, 'LR')
    const p = Object.fromEntries(placed.map((n) => [n.id, n]))
    expect(ranks).toBe(3)
    expect(breadth).toBe(2)
    expect(p.a.x).toBeLessThan(p.b.x)
    expect(p.c.x).toBe(p.d.x)
    expect(p.c.y).not.toBe(p.d.y)
  })

  it('TB puts ranks on y and spreads branches sideways', () => {
    const { placed } = placeDiagram(d, 'TB')
    const p = Object.fromEntries(placed.map((n) => [n.id, n]))
    expect(p.a.y).toBeLessThan(p.b.y)
    expect(p.b.y).toBeLessThan(p.c.y)
    expect(p.c.y).toBe(p.d.y)
    expect(p.c.x).toBeLessThan(p.d.x)
    expect(p.a.x).toBe(0)
  })
})

describe('canonicalJson', () => {
  it('ignores key order and undefined values', () => {
    expect(canonicalJson({ b: 1, a: [{ y: 2, x: undefined, z: 'q' }] })).toBe(canonicalJson({ a: [{ z: 'q', y: 2 }], b: 1 }))
  })
})

describe('feeder chains', () => {
  it('keeps the trunk straight and runs a lead bank → cron chain beside it', () => {
    const ids = ['import', 'validate', 'enrich', 'push', 'send', 'reply', 'bank', 'cron']
    const p = Object.fromEntries(
      layoutDiagram({
        nodes: ids.map((id) => ({ id, label: id, kind: 'step' as const, state: 'planned' as const })),
        edges: [
          { from: 'import', to: 'validate' },
          { from: 'validate', to: 'enrich' },
          { from: 'enrich', to: 'push' },
          { from: 'push', to: 'send' },
          { from: 'send', to: 'reply' },
          { from: 'bank', to: 'cron' },
          { from: 'cron', to: 'send' },
        ],
      }).map((x) => [x.id, x])
    )
    expect(p.cron.rank).toBe(p.send.rank - 1)
    expect(p.bank.rank).toBe(p.send.rank - 2)
    expect(new Set(['import', 'validate', 'enrich', 'push'].map((id) => p[id].row)).size).toBe(1)
    expect(p.bank.row).toBe(p.cron.row)
    expect(p.bank.row).not.toBe(p.enrich.row)
  })
})

describe('parseDiagram identity (streaming re-renders)', () => {
  const text = JSON.stringify({ title: 't', nodes: [{ id: 'a', label: 'A', kind: 'step', state: 'planned' }, { id: 'b', label: 'B', kind: 'step', state: 'planned' }], edges: [{ from: 'a', to: 'b' }] })

  it('returns the same diagram object for the same text, so React Flow keeps its node measurements', () => {
    const a = parseDiagram(text)
    const b = parseDiagram(`${text}`.slice(0))
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) expect(b.diagram).toBe(a.diagram)
  })

  it('chatDiagrams keeps a finished diagram stable while the reply keeps streaming after it', () => {
    const before = chatDiagrams([{ id: 'm', role: 'assistant', text: '```flow\n' + text + '\n```\nNext I will' }])
    const after = chatDiagrams([{ id: 'm', role: 'assistant', text: '```flow\n' + text + '\n```\nNext I will check the queue' }])
    expect(after[0].diagram).toBe(before[0].diagram)
  })
})
