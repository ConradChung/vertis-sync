import { describe, expect, it } from 'vitest'
import { findVertical, groupByTag, matchesTag, scopeByTag, shortTag, TagBody, tagFilterOptions, tagName, tagPromptLine } from '@/lib/tags/model'

const KAS = { id: '466d9a53-6450-49df-a063-8e66437efa8b', name: 'Kaspen / Zenport' }
const JOBS = { id: '5b54bc53-ac4a-49a3-b13a-a299b2d6b38f', name: 'Job search / GTM roles' }
const HNWI = { id: 'ff518c13-b4a8-4490-b308-438846e8b250', name: 'HNWI / wealth management' }
const VS = [HNWI, JOBS, KAS]

const gate = (id: string, v: { id: string; name: string } | null) => ({ kind: 'jobs_fill', target_table: 'job_batches', target_id: id, title: `t-${id}`, subtitle: 'long', vertical_id: v?.id ?? null, vertical_name: v?.name ?? null })
const brief = (g: ReturnType<typeof gate>) => ({ target_id: g.target_id, title: g.title })
const items = [gate('a', KAS), gate('b', JOBS), gate('c', JOBS), gate('d', null), gate('e', JOBS), gate('f', HNWI)]

describe('tags model', () => {
  it('names a tag; Untagged for none; the row name when the list is not loaded', () => {
    expect(tagName(KAS.id, VS)).toBe('Kaspen / Zenport')
    expect(tagName(null, VS)).toBe('Untagged')
    expect(tagName(KAS.id, [], 'Kaspen / Zenport')).toBe('Kaspen / Zenport')
    expect(shortTag('Kaspen / Zenport')).toBe('Kaspen')
    expect(shortTag('Roofers')).toBe('Roofers')
  })

  it('finds a vertical by id, exact name or one unambiguous word', () => {
    expect(findVertical(KAS.id, VS)).toBe(KAS)
    expect(findVertical('kaspen', VS)).toBe(KAS)
    expect(findVertical('Job search', VS)).toBe(JOBS)
    expect(findVertical('the kaspen campaign', VS)).toBe(KAS)
    expect(findVertical('o', VS)).toBeNull() // several match
    expect(findVertical('dentists', VS)).toBeNull()
  })

  it('groups by tag A→Z with Untagged last, keeping order inside a group', () => {
    const g = groupByTag(items)
    expect(g.map((x) => x.tag)).toEqual(['HNWI / wealth management', 'Job search / GTM roles', 'Kaspen / Zenport', 'Untagged'])
    expect(g[1].items.map((i) => i.target_id)).toEqual(['b', 'c', 'e'])
  })

  it("a tagged chat: its tag in full, untagged briefly, other tags as one count line", () => {
    const s = scopeByTag(items, { focus: KAS, verticals: VS, brief, noun: 'waiting' })
    expect(s.scope).toBe('tag')
    if (s.scope !== 'tag') return
    expect(s.tag).toBe('Kaspen / Zenport')
    expect(s.items.map((i) => i.target_id)).toEqual(['a'])
    expect(s.untagged).toEqual([{ target_id: 'd', title: 't-d' }])
    expect(s.other_tags).toEqual([
      { tag: 'HNWI / wealth management', count: 1, note: '1 more waiting in HNWI / wealth management — ask to see them' },
      { tag: 'Job search / GTM roles', count: 3, note: '3 more waiting in Job search / GTM roles — ask to see them' },
    ])
    expect(JSON.stringify(s)).not.toContain('t-b') // no job-search item leaks into a Kaspen answer
  })

  it('all: everything grouped; an untagged chat behaves like all', () => {
    expect(scopeByTag(items, { focus: KAS, all: true, verticals: VS, brief, noun: 'waiting' })).toMatchObject({ scope: 'all', groups: [{}, {}, {}, {}] })
    const none = scopeByTag(items, { focus: null, verticals: VS, brief, noun: 'waiting' })
    expect(none.scope).toBe('all')
  })

  it('vertical overrides the chat tag; "untagged" lists the untagged; an unknown name says so and shows all', () => {
    const j = scopeByTag(items, { focus: KAS, vertical: 'job search', verticals: VS, brief, noun: 'waiting' })
    expect(j).toMatchObject({ scope: 'tag', tag: 'Job search / GTM roles' })
    if (j.scope === 'tag') expect(j.items).toHaveLength(3)
    const u = scopeByTag(items, { focus: KAS, vertical: 'untagged', verticals: VS, brief, noun: 'waiting' })
    expect(u).toMatchObject({ scope: 'tag', tag: 'Untagged' })
    if (u.scope === 'tag') expect(u.items.map((i) => i.target_id)).toEqual(['d'])
    const x = scopeByTag(items, { focus: null, vertical: 'dentists', verticals: VS, brief, noun: 'waiting' })
    expect(x.scope).toBe('all')
    expect(x.note).toMatch(/No single tag matches "dentists"/)
  })

  it('filter options and matching for Progress', () => {
    expect(tagFilterOptions(items)).toEqual([
      { id: HNWI.id, name: 'HNWI', count: 1 },
      { id: JOBS.id, name: 'Job search', count: 3 },
      { id: KAS.id, name: 'Kaspen', count: 1 },
      { id: null, name: 'Untagged', count: 1 },
    ])
    expect(matchesTag(items[0], 'all')).toBe(true)
    expect(matchesTag(items[0], KAS.id)).toBe(true)
    expect(matchesTag(items[1], KAS.id)).toBe(false)
    expect(matchesTag(items[3], 'untagged')).toBe(true)
  })

  it('PATCH body: a known table, uuids, null clears', () => {
    expect(TagBody.safeParse({ table: 'job_batches', id: KAS.id, vertical_id: null }).success).toBe(true)
    expect(TagBody.safeParse({ table: 'agent_runs', id: KAS.id, vertical_id: null }).success).toBe(false)
    expect(TagBody.safeParse({ table: 'job_batches', id: 'x', vertical_id: KAS.id }).success).toBe(false)
    expect(TagBody.safeParse({ table: 'job_batches', id: KAS.id, vertical_id: KAS.id, extra: 1 }).success).toBe(false)
  })

  it('the prompt line names the tag and says to leave other tags alone; none for an untagged chat', () => {
    expect(tagPromptLine(null)).toBeNull()
    const line = tagPromptLine(KAS)!
    expect(line).toContain('This chat is tagged Kaspen / Zenport')
    expect(line).toMatch(/don't bring up other tags' work/)
  })
})
