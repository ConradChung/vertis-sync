import { describe, expect, it } from 'vitest'
import { describeCriteria, matchRows, normaliseLead, planFilter, summarise, type ReviewRow } from '@/lib/review/model'
import { keptApolloCsv } from '@/lib/review/export'
import { pageRows } from '@/lib/review/query'
import { APOLLO_CSV_COLUMNS, domainOf } from '@/lib/apollo/records'

const maps = (o: Record<string, unknown>) => ({
  title: 'Acme Roofing',
  categoryName: 'Roofing contractor',
  city: 'Austin',
  state: 'Texas',
  website: 'https://www.acmeroofing.com/',
  phone: '+1 512-555-0100',
  totalScore: 4.7,
  reviewsCount: 120,
  ...o,
})

const rows = (items: Record<string, unknown>[]): ReviewRow[] =>
  items.map((raw, idx) => ({ idx, item: normaliseLead(raw), status: 'kept', excluded_reason: null, filter_id: null }))

describe('normaliseLead', () => {
  it('maps Google Maps fields', () => {
    const it = normaliseLead(maps({}))
    expect(it).toMatchObject({
      name: 'Acme Roofing',
      category: 'Roofing contractor',
      city: 'Austin',
      state: 'Texas',
      domain: 'acmeroofing.com',
      phone: '+1 512-555-0100',
      rating: 4.7,
      reviews_count: 120,
      email: null,
      linkedin_url: null,
    })
  })

  it('ignores social and maps links as company domains', () => {
    expect(domainOf('https://www.facebook.com/acme')).toBeNull()
    expect(domainOf('acme.co.uk/contact')).toBe('acme.co.uk')
  })
})

describe('filters', () => {
  const set = rows([
    maps({}),
    maps({ title: 'Roof Depot Franchise', website: null }),
    maps({ title: 'Bob Gutters', categoryName: 'Gutter cleaning service', totalScore: 3.2, website: 'bobgutters.com' }),
    maps({ title: 'Acme Roofing 2', website: 'acmeroofing.com/about', reviewsCount: 3 }),
  ])

  it('excludes by missing website, keyword, rating and duplicate domain', () => {
    expect([...matchRows(set, { missing: ['website'] })]).toEqual([1])
    expect([...matchRows(set, { keywords: ['franchise'] })]).toEqual([1])
    expect([...matchRows(set, { rating_below: 4 })]).toEqual([2])
    expect([...matchRows(set, { duplicate_domain: true })]).toEqual([3])
    expect([...matchRows(set, { reviews_below: 10, categories_in: ['roofing contractor'] })]).toEqual([3])
  })

  it('keep_only drops the non-matching kept rows', () => {
    expect(planFilter(set, { categories_in: ['Roofing contractor'] }, 'keep_only')).toEqual([2])
    expect(planFilter(set, { item_ids: [0, 3] }, 'exclude')).toEqual([0, 3])
  })

  it('only touches kept rows', () => {
    const s2 = set.map((r) => (r.idx === 1 ? { ...r, status: 'excluded' as const } : r))
    expect(planFilter(s2, { missing: ['website'] }, 'exclude')).toEqual([])
  })

  it('describes criteria for chips', () => {
    expect(describeCriteria({ missing: ['website'], rating_below: 4 }, 'exclude')).toBe('Exclude: rating < 4, no website')
  })

  it('summarises kept rows with coverage and histograms', () => {
    const s = summarise(set.map((r) => (r.idx === 2 ? { ...r, status: 'excluded' as const } : r)))
    expect(s).toMatchObject({ total: 4, kept: 3, excluded: 1, duplicate_domains: 1 })
    expect(s.coverage).toEqual({ website: 2, phone: 3, email: 0, linkedin: 0 })
    expect(s.categories[0]).toEqual({ value: 'Roofing contractor', count: 3 })
  })

  it('pages and searches rows', () => {
    expect(pageRows(set, { status: 'kept', q: 'gutter', page: 0, pageSize: 10 }).rows.map((r) => r.idx)).toEqual([2])
    expect(pageRows(set, { status: 'all', page: 1, pageSize: 3 })).toMatchObject({ total: 4, page: 1, rows: [{ idx: 3 }] })
  })
})

describe('Apollo export', () => {
  it('exports only kept rows in Apollo columns', () => {
    const set = rows([maps({}), maps({ title: 'Dropped Co', website: 'dropped.com' })]).map((r) => (r.idx === 1 ? { ...r, status: 'excluded' as const } : r))
    const { csv, rows: n } = keptApolloCsv(set)
    expect(n).toBe(1)
    const [head, line] = csv.trim().split('\n')
    expect(head).toBe(APOLLO_CSV_COLUMNS.join(','))
    expect(line).toContain('Acme Roofing')
    expect(line).toContain('acmeroofing.com')
    expect(csv).not.toContain('Dropped Co')
  })
})
