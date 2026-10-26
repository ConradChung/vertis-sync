import { describe, expect, it } from 'vitest'
import { buildCatalog, pickInitial } from '@/lib/playground/catalog'
import { parseRef, refKey } from '@/lib/playground/model'
import type { Skill } from '@/lib/agent/skillModel'
import type { CampaignTableRow } from '@/lib/campaigns/types'
import type { SavedDiagram } from '@/lib/playground/model'

const saved = [{ id: 'd1', title: 'Brainstorm', spec: { nodes: [{ id: 'a', label: 'A', kind: 'step', state: 'planned' }], edges: [] } }] as unknown as SavedDiagram[]
const campaigns = [
  { key: 'c1', instantly_id: 'c1', name: 'Scaleport - Fall Mega', status: 'paused' },
  { key: 'lume:x', instantly_id: null, name: 'Muse auto-apply', status: 'manual' },
] as CampaignTableRow[]
const skills = [{ id: 's1', name: 'Kaspen', steps: [{ type: 'launch' }] }] as Skill[]

describe('Playground catalog', () => {
  it('groups saved, campaign flows (Instantly only) and skills in order', () => {
    const g = buildCatalog({ saved, campaigns, skills })
    expect(g.map((x) => x.label)).toEqual(['Saved diagrams', 'Campaign flows', 'Skills'])
    expect(g[1].items.map((i) => i.label)).toEqual(['Scaleport - Fall Mega'])
    expect(g[2].items[0]).toMatchObject({ key: 'skill:s1', hint: '1 steps' })
  })

  it('drops empty groups', () => {
    expect(buildCatalog({ skills }).map((x) => x.kind)).toEqual(['skill'])
    expect(buildCatalog({})).toEqual([])
  })

  it('parses ?d= refs and refuses junk', () => {
    expect(parseRef('campaign:c1')).toEqual({ kind: 'campaign', id: 'c1' })
    expect(parseRef('saved:0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c')?.kind).toBe('saved')
    expect(parseRef('evil:1')).toBeNull()
    expect(parseRef('skill:../x')).toBeNull()
    expect(parseRef(null)).toBeNull()
    expect(refKey({ kind: 'skill', id: 's1' })).toBe('skill:s1')
  })

  it('prefers the URL pick, else the first item', () => {
    const g = buildCatalog({ saved, campaigns, skills })
    expect(pickInitial(g, { kind: 'skill', id: 's1' })).toEqual({ kind: 'skill', id: 's1' })
    expect(pickInitial(g, null)).toEqual({ kind: 'saved', id: 'd1' })
    expect(pickInitial([], null)).toBeNull()
  })
})
