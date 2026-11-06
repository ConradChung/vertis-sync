import { describe, expect, it } from 'vitest'
import {
  planApproval,
  candidateColumnMapping,
  estimateLookup,
  LOOKUP_USD_PER_PERSON,
  normalizePersonName,
  planCandidates,
  UnknownCandidateColumnError,
} from '@/lib/influencers/candidates'

/** The owner's list: Name, Title / Role, Company / Organization, Category, Focus / Notes, Source Context. */
const HEADER = ['Name', 'Title / Role', 'Company / Organization', 'Category', 'Focus / Notes', 'Source Context']

describe('candidateColumnMapping', () => {
  it("maps the owner's list headers", () => {
    expect(candidateColumnMapping(HEADER).mapping).toEqual({
      name: 'Name', title: 'Title / Role', company: 'Company / Organization', category: 'Category', notes: 'Focus / Notes', source_context: 'Source Context',
    })
  })
  it('overrides win; a missing name column or an unknown header is refused', () => {
    expect(candidateColumnMapping(['Person', 'Org'], { name: 'person', company: 'Org' }).mapping).toEqual({ name: 'Person', company: 'Org' })
    expect(() => candidateColumnMapping(['Org'])).toThrow(UnknownCandidateColumnError)
    expect(() => candidateColumnMapping(['Name'], { company: 'Nope' })).toThrow(UnknownCandidateColumnError)
  })
})

describe('normalizePersonName', () => {
  it('folds accents, case, honorifics, nicknames in brackets and credentials after a comma', () => {
    expect(normalizePersonName('Dr. José  Álvarez (Pepe), CPM')).toBe('jose alvarez')
    expect(normalizePersonName('Jennifer Ruelens (PM Jen)')).toBe('jennifer ruelens')
    expect(normalizePersonName('  PETER lohmann ')).toBe('peter lohmann')
  })
})

describe('planCandidates', () => {
  const header = HEADER
  const rows = [
    ['Sarah Johnson', 'Director', 'Greystar', 'Operator', 'Ops', 'Podcast'],
    ['', 'x', 'y', '', '', ''],
    ['Peter Lohmann', 'Founder', 'RL PM', '', '', ''],
    ['sarah johnson', 'Director', 'Greystar', '', '', ''],
    ['Sarah Johnson', 'Founder', 'Other Co', '', '', ''],
  ]
  it('a name already among influencers is only noted (possible_duplicate_of) and still looked up; a repeat in the list needs the same name AND company', () => {
    const plan = planCandidates(header, rows, candidateColumnMapping(header).mapping, [{ id: 'inf-1', name: 'Peter Lohmann' }])
    expect(plan.skipped_no_name).toBe(1)
    expect(plan.rows).toEqual([
      { row_index: 0, name: 'Sarah Johnson', title: 'Director', company: 'Greystar', category: 'Operator', notes: 'Ops', source_context: 'Podcast', status: 'pending_lookup', influencer_id: null, possible_duplicate_of: null },
      { row_index: 2, name: 'Peter Lohmann', title: 'Founder', company: 'RL PM', category: null, notes: null, source_context: null, status: 'pending_lookup', influencer_id: null, possible_duplicate_of: 'inf-1' },
      { row_index: 3, name: 'sarah johnson', title: 'Director', company: 'Greystar', category: null, notes: null, source_context: null, status: 'duplicate', influencer_id: null, possible_duplicate_of: null },
      { row_index: 4, name: 'Sarah Johnson', title: 'Founder', company: 'Other Co', category: null, notes: null, source_context: null, status: 'pending_lookup', influencer_id: null, possible_duplicate_of: null },
    ])
    expect(plan.to_look_up).toBe(3)
  })
})

describe('estimateLookup', () => {
  it('people x the per-person cost; the default hard cap leaves 25 % headroom, between $0.10 and $50', () => {
    expect(LOOKUP_USD_PER_PERSON).toBe(0.0065)
    expect(estimateLookup(146)).toEqual({ people: 146, usd: 0.95, default_cap_usd: 1.19 })
    expect(estimateLookup(1).default_cap_usd).toBe(0.1)
    expect(estimateLookup(100_000).default_cap_usd).toBe(50)
  })
  it('matches the edge function\'s per-person cost', async () => {
    const edge = (await import(/* @vite-ignore */ new URL('../../../supabase/functions/_shared/influencer/lookup.ts', import.meta.url).href)) as { LOOKUP_USD_PER_PERSON: number }
    expect(edge.LOOKUP_USD_PER_PERSON).toBe(LOOKUP_USD_PER_PERSON)
  })
})

describe('planApproval', () => {
  it('creates inactive influencers with unique slugs; links an existing profile; skips what cannot be approved', () => {
    const plan = planApproval(
      [
        { id: 'c1', name: 'Sarah Johnson', title: 'Director', company: 'Greystar', category: 'Operator', status: 'found', linkedin_url: 'https://www.linkedin.com/in/sarah-johnson' },
        { id: 'c2', name: 'Peter Lohmann', title: null, company: null, category: null, status: 'found', linkedin_url: 'https://www.linkedin.com/in/pslohmann' },
        { id: 'c3', name: 'Sarah Johnson', title: null, company: 'Other', category: null, status: 'found', linkedin_url: 'https://www.linkedin.com/in/sarah-j-2' },
        { id: 'c4', name: 'No Url', title: null, company: null, category: null, status: 'not_found', linkedin_url: null },
        { id: 'c5', name: 'Twin', title: null, company: null, category: null, status: 'found', linkedin_url: 'https://www.linkedin.com/in/sarah-johnson' },
      ],
      [{ id: 'inf-1', slug: 'peter-lohmann', linkedin_url: 'https://linkedin.com/in/PSLohmann/' }, { id: 'inf-2', slug: 'sarah-johnson', linkedin_url: 'https://www.linkedin.com/in/someone-else' }]
    )
    expect(plan.create).toEqual([
      { candidate_id: 'c1', influencer: { name: 'Sarah Johnson', slug: 'sarah-johnson-2', linkedin_url: 'https://www.linkedin.com/in/sarah-johnson', notes: 'Director · Greystar · Operator', active: false } },
      { candidate_id: 'c3', influencer: { name: 'Sarah Johnson', slug: 'sarah-johnson-3', linkedin_url: 'https://www.linkedin.com/in/sarah-j-2', notes: 'Other', active: false } },
    ])
    expect(plan.link).toEqual([{ candidate_id: 'c2', influencer_id: 'inf-1' }])
    expect(plan.skipped).toEqual([
      { candidate_id: 'c4', reason: 'no LinkedIn URL found (status not_found)' },
      { candidate_id: 'c5', reason: 'same profile as another candidate in this approval' },
    ])
  })
})
