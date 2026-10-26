import { describe, expect, it } from 'vitest'
import { DETAILS_MAX_CHARS, DIAGRAM_MAX_NODES, diagramSchema, flowOrder, hasDetails, parseDiagram } from '@/lib/agent/diagram'

const base = {
  title: 'D3 outbound',
  nodes: [
    { id: 'icp', label: 'Target & ICP', kind: 'step' },
    { id: 'maps', label: 'Google Maps', kind: 'source' },
    { id: 'apollo', label: 'Apollo order', kind: 'source' },
    { id: 'review', label: 'Review & filter', kind: 'step' },
  ],
  edges: [
    { from: 'icp', to: 'maps' },
    { from: 'icp', to: 'apollo' },
    { from: 'maps', to: 'review' },
    { from: 'apollo', to: 'review' },
  ],
}

describe('diagram details', () => {
  it('still parses old specs without details (back-compat)', () => {
    const r = parseDiagram(JSON.stringify(base))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.diagram.nodes.every((n) => n.details === undefined && !hasDetails(n))).toBe(true)
  })

  it('accepts a full details object and normalises single strings to lists', () => {
    const spec = structuredClone(base) as typeof base & { nodes: Record<string, unknown>[] }
    spec.nodes[1].details = {
      why: 'Map listings carry website and phone for owner-operated roofers.',
      how: 'Run the actor for Austin, TX',
      tools: ['run_apify_actor'],
      actors: [{ id: 'compass/crawler-google-places', name: 'Google Maps Scraper', price: '$4 per 1,000', fields: ['website', 'phone'] }],
      data: [{ label: 'Est. results', value: 800, source: 'https://apify.com/compass/crawler-google-places' }],
      owner: 'Conrad tap',
      approval: true,
      cost: '≤ $12',
      decision: 'How many leads do you want?',
      links: [{ label: 'Rotate', url: '/rotate' }],
    }
    const r = parseDiagram(JSON.stringify(spec))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const d = r.diagram.nodes[1].details!
    expect(d.how).toEqual(['Run the actor for Austin, TX'])
    expect(d.decision).toEqual(['How many leads do you want?'])
    expect(d.data?.[0].value).toBe('800')
    expect(hasDetails(r.diagram.nodes[1])).toBe(true)
  })

  it('drops oversized or malformed details on one node without rejecting the diagram', () => {
    const spec = structuredClone(base) as typeof base & { nodes: Record<string, unknown>[] }
    spec.nodes[0].details = { why: 'x'.repeat(600), how: Array.from({ length: 12 }, () => 'y'.repeat(200)) }
    spec.nodes[1].details = { links: [{ label: 'bad', url: 'javascript:alert(1)' }] }
    spec.nodes[2].details = { why: 'kept' }
    expect(JSON.stringify(spec.nodes[0].details).length).toBeGreaterThan(DETAILS_MAX_CHARS)
    const r = parseDiagram(JSON.stringify(spec))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.diagram.nodes[0].details).toBeUndefined()
    expect(r.diagram.nodes[1].details).toBeUndefined()
    expect(r.diagram.nodes[2].details).toEqual({ why: 'kept' })
  })

  it('caps nodes at 40 and the whole spec size', () => {
    const many = { nodes: Array.from({ length: DIAGRAM_MAX_NODES + 1 }, (_, i) => ({ id: `n${i}`, label: `N${i}` })), edges: [] }
    expect(DIAGRAM_MAX_NODES).toBe(40)
    expect(diagramSchema.safeParse(many).success).toBe(false)
    expect(diagramSchema.safeParse({ ...many, nodes: many.nodes.slice(0, 40) }).success).toBe(true)
    const big = {
      nodes: Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, label: `N${i}`, detail: 'd'.repeat(160), details: { why: 'w'.repeat(700), cost: 'c'.repeat(100), eta: 'e'.repeat(80), owner: 'o'.repeat(40) } })),
      edges: [],
    }
    expect(diagramSchema.safeParse(big).success).toBe(false)
  })

  it('orders nodes by flow (rank, then row) for next / previous', () => {
    expect(flowOrder(diagramSchema.parse(base))).toEqual(['icp', 'maps', 'apollo', 'review'])
  })
})
