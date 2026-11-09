import { z } from 'zod'

/**
 * Tags: an item's line of business. The tag IS the vertical (`lume_verticals`);
 * `vertical_id` on the pipeline tables (migration 20261109092501_lume_tags)
 * is filled by triggers and can be changed by the owner (PATCH /api/tags,
 * the agent's tag_item). Pure: shapes, labels and the agent's scoping.
 */

export const TAG_TABLES = [
  'job_batches',
  'telegram_ingests',
  'validation_jobs',
  'lead_review_sets',
  'apollo_orders',
  'lume_tasks',
  'pending_actions',
] as const
export type TagTable = (typeof TAG_TABLES)[number]

export interface TagRef {
  table: TagTable
  id: string
}

export interface TagVertical {
  id: string
  name: string
}

export const UNTAGGED = 'Untagged'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** PATCH /api/tags: `vertical_id` null clears the tag. */
export const TagBody = z
  .object({
    table: z.enum(TAG_TABLES),
    id: z.string().regex(UUID, 'uuid'),
    vertical_id: z.string().regex(UUID, 'uuid').nullable(),
  })
  .strict()

export const isTagTable = (t: unknown): t is TagTable => typeof t === 'string' && (TAG_TABLES as readonly string[]).includes(t)

/** The name to show for a tag; "Untagged" for none, a short id for a vertical no longer listed. */
export function tagName(verticalId: string | null | undefined, verticals: readonly TagVertical[], knownName?: string | null): string {
  if (!verticalId) return UNTAGGED
  return verticals.find((v) => v.id === verticalId)?.name ?? knownName ?? 'Unknown tag'
}

/** "Kaspen / Zenport" → "Kaspen" for a filter pill. */
export const shortTag = (name: string) => name.split(/\s+[/·|]\s+/)[0].trim() || name

/**
 * A vertical by what the owner or the agent typed: its id, its exact name or
 * a case-insensitive word match ("kaspen", "job search", "recruiting" when the
 * name says so). Null when nothing or more than one matches.
 */
export function findVertical<V extends TagVertical>(query: string, verticals: readonly V[]): V | null {
  const q = query.trim().toLowerCase()
  if (!q) return null
  const exact = verticals.find((v) => v.id.toLowerCase() === q || v.name.toLowerCase() === q)
  if (exact) return exact
  const hits = verticals.filter((v) => v.name.toLowerCase().includes(q) || q.includes(shortTag(v.name).toLowerCase()))
  return hits.length === 1 ? hits[0] : null
}

// ---------------------------------------------------------------------------
// Grouping and the agent's scoping

export interface Tagged {
  vertical_id?: string | null
  vertical_name?: string | null
}

export interface TagGroup<T> {
  tag: string
  vertical_id: string | null
  items: T[]
}

/** Items by tag: named tags A→Z, Untagged last. Order within a group is kept. */
export function groupByTag<T extends Tagged>(items: readonly T[], verticals: readonly TagVertical[] = []): TagGroup<T>[] {
  const groups = new Map<string, TagGroup<T>>()
  for (const item of items) {
    const key = item.vertical_id ?? ''
    let g = groups.get(key)
    if (!g) {
      g = { tag: tagName(item.vertical_id, verticals, item.vertical_name), vertical_id: item.vertical_id ?? null, items: [] }
      groups.set(key, g)
    }
    g.items.push(item)
  }
  return [...groups.values()].sort((a, b) => (!a.vertical_id ? 1 : !b.vertical_id ? -1 : a.tag.localeCompare(b.tag)))
}

export interface ScopeOptions<T> {
  /** The chat's tag (its own vertical, else its project's); null: no tag. */
  focus: TagVertical | null
  /** Everything, grouped by tag (the owner asked for all). */
  all?: boolean
  /** One tag by id / name ("kaspen"), or "untagged"; overrides the chat's tag. */
  vertical?: string | null
  verticals: readonly TagVertical[]
  /** The short form of an untagged item (listed briefly in a focused answer). */
  brief: (item: T) => Record<string, unknown>
  /** Plural noun for the collapsed lines: "waiting", "tasks". */
  noun: string
}

export type Scoped<T> =
  | { scope: 'tag'; tag: string; items: T[]; untagged: Record<string, unknown>[]; other_tags: { tag: string; count: number; note: string }[]; note?: string }
  | { scope: 'all'; groups: TagGroup<T>[]; note?: string }

/**
 * What a list tool returns to the agent. A tagged chat (or an explicit
 * `vertical`) gets that tag's items in full, untagged items briefly and every
 * other tag collapsed to one line; `all` (or an untagged chat) gets everything
 * grouped by tag.
 */
export function scopeByTag<T extends Tagged>(items: readonly T[], opts: ScopeOptions<T>): Scoped<T> {
  const groups = groupByTag(items, opts.verticals)
  if (opts.all) return { scope: 'all', groups }
  let focus = opts.focus
  let note: string | undefined
  if (opts.vertical) {
    if (opts.vertical.trim().toLowerCase() === UNTAGGED.toLowerCase()) {
      return { scope: 'tag', tag: UNTAGGED, items: items.filter((i) => !i.vertical_id), untagged: [], other_tags: collapse(groups, null, opts.noun) }
    }
    const v = findVertical(opts.vertical, opts.verticals)
    if (v) focus = v
    else note = `No single tag matches "${opts.vertical}"; tags: ${opts.verticals.map((x) => x.name).join(', ') || 'none'}.`
  }
  if (!focus) return note ? { scope: 'all', groups, note } : { scope: 'all', groups }
  const mine = items.filter((i) => i.vertical_id === focus!.id)
  const untagged = items.filter((i) => !i.vertical_id).map(opts.brief)
  const out: Scoped<T> = { scope: 'tag', tag: focus.name, items: mine, untagged, other_tags: collapse(groups, focus.id, opts.noun) }
  return note ? { ...out, note } : out
}

function collapse<T>(groups: TagGroup<T>[], focusId: string | null, noun: string) {
  return groups
    .filter((g) => g.vertical_id && g.vertical_id !== focusId)
    .map((g) => ({ tag: g.tag, count: g.items.length, note: `${g.items.length} more ${noun} in ${g.tag} — ask to see them` }))
}

/** The per-run line for a tagged chat (put ahead of the user turn; null for an untagged chat). */
export function tagPromptLine(tag: TagVertical | null): string | null {
  if (!tag) return null
  return (
    `This chat is tagged ${tag.name}. Your to-do tools (get_validation_queue, get_progress, list_tasks) return ${tag.name}'s items in full, ` +
    "untagged ones briefly and other tags as one count line each. Answer about this tag's work; mention untagged items briefly; " +
    "don't bring up other tags' work beyond those count lines unless Conrad asks (then pass vertical or all: true)."
  )
}

// ---------------------------------------------------------------------------
// Progress's tag filter ("All · Kaspen · Job search …")

/** One option per tag present in the items (A→Z, Untagged last), with counts; short names. */
export function tagFilterOptions(items: readonly Tagged[], verticals: readonly TagVertical[] = []): { id: string | null; name: string; count: number }[] {
  return groupByTag(items, verticals).map((g) => ({ id: g.vertical_id, name: g.vertical_id ? shortTag(g.tag) : UNTAGGED, count: g.items.length }))
}

/** `key` is 'all', 'untagged' or a vertical id. */
export function matchesTag(item: Tagged, key: string): boolean {
  if (key === 'all') return true
  if (key === 'untagged') return !item.vertical_id
  return item.vertical_id === key
}
