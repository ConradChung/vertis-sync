import type { Skill } from '@/lib/agent/skillModel'
import type { CampaignTableRow } from '@/lib/campaigns/types'
import type { PlaygroundKind, PlaygroundRef, SavedDiagram } from '@/lib/playground/model'
import { refKey } from '@/lib/playground/model'

/** The Playground dropdown: saved diagrams, campaign flows, skills — grouped, in that order. */

export interface CatalogItem {
  ref: PlaygroundRef
  key: string
  label: string
  hint: string
}

export interface CatalogGroup {
  kind: PlaygroundKind
  label: string
  items: CatalogItem[]
}

export function buildCatalog(input: { saved?: SavedDiagram[]; campaigns?: CampaignTableRow[]; skills?: Skill[] }): CatalogGroup[] {
  const item = (kind: PlaygroundKind, id: string, label: string, hint: string): CatalogItem => {
    const ref = { kind, id }
    return { ref, key: refKey(ref), label, hint }
  }
  return [
    {
      kind: 'saved' as const,
      label: 'Saved diagrams',
      items: (input.saved ?? []).map((d) => item('saved', d.id, d.title, `${d.spec.nodes.length} steps`)),
    },
    {
      kind: 'campaign' as const,
      label: 'Campaign flows',
      // Only Instantly campaigns have a Flow (the route takes the Instantly id).
      items: (input.campaigns ?? []).filter((c) => c.instantly_id).map((c) => item('campaign', c.instantly_id!, c.name, c.status)),
    },
    {
      kind: 'skill' as const,
      label: 'Skills',
      items: (input.skills ?? []).map((s) => item('skill', s.id, s.name, `${s.steps.length} steps`)),
    },
  ].filter((g) => g.items.length > 0)
}

/** The URL's pick when it exists in the catalog (saved ids may not be listed yet), else the first item. */
export function pickInitial(groups: CatalogGroup[], fromUrl: PlaygroundRef | null): PlaygroundRef | null {
  if (fromUrl) return fromUrl
  return groups[0]?.items[0]?.ref ?? null
}
