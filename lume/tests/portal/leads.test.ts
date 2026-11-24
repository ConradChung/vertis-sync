import { beforeEach, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  clearPortalRegionCache,
  ilikeOrValue,
  mapEmailRow,
  mapLinkedinRow,
  mapSheetRow,
  parsePortalLeadsQuery,
  portalLeadsResponse,
  portalRegions,
  searchOrFilter,
  searchPortalLeads,
} from '@/lib/portal/leads'
import type { PortalUser } from '@/lib/portal/access'

/** Chainable PostgREST stand-in that records every call and resolves to `result`. */
export function fakeDb(results: Array<{ data: unknown; count?: number | null; error?: { message: string } | null }>) {
  const calls: Array<{ table: string; ops: Array<[string, unknown[]]> }> = []
  const db = {
    from(table: string) {
      const rec = { table, ops: [] as Array<[string, unknown[]]> }
      calls.push(rec)
      const b: Record<string, unknown> = {}
      for (const op of ['select', 'in', 'or', 'not', 'eq', 'order', 'range', 'insert', 'update', 'delete', 'upsert']) {
        b[op] = (...args: unknown[]) => {
          rec.ops.push([op, args])
          return b
        }
      }
      b.then = (resolve: (v: unknown) => unknown) => resolve(results.shift() ?? { data: [], count: 0, error: null })
      return b
    },
  }
  return { db: db as unknown as SupabaseClient, calls }
}

const user: PortalUser = { email: 'frank@getzenport.com', client: 'Kaspen', campaign_ids: ['camp-1', 'camp-2'], linkedin_set_ids: ['set-1'], sheet_set_ids: ['sheet-1'] }

describe('parsePortalLeadsQuery', () => {
  const p = (qs: string) => parsePortalLeadsQuery(new URLSearchParams(qs))
  it('parses and defaults', () => {
    expect(p('').data).toEqual({ tab: 'email', page: 1 })
    expect(p('tab=linkedin&q=%20acme%20&has_phone=true&status=replied_positive&sort=region&page=3&region=Texas').data).toEqual({
      tab: 'linkedin', q: 'acme', has_phone: true, status: 'replied_positive', sort: 'region', page: 3, region: 'Texas',
    })
    expect(p('has_phone=0').data?.has_phone).toBe(false)
    expect(p('q=%20%20').data?.q).toBeUndefined()
  })
  it('ignores scope-looking params entirely', () => {
    const r = p('campaign_id=evil&campaign_ids=evil&set_id=evil&as=x@y.co')
    expect(r.success).toBe(true)
    expect(r.data).toEqual({ tab: 'email', page: 1 })
  })
  it('rejects bad values', () => {
    for (const qs of ['tab=sms', 'sort=email', 'status=all', 'page=0', 'page=abc', 'has_phone=yes', `q=${'x'.repeat(201)}`]) {
      expect(p(qs).success).toBe(false)
    }
  })
})

describe('PostgREST escaping', () => {
  it('quotes the value and escapes LIKE wildcards', () => {
    expect(ilikeOrValue('acme')).toBe('"*acme*"')
    expect(ilikeOrValue('50%_off')).toBe('"*50\\\\%\\\\_off*"')
    expect(ilikeOrValue('Acme, Inc. (TX): a')).toBe('"*Acme, Inc. (TX): a*"')
    expect(ilikeOrValue('a"b\\c*d')).toBe('"*a_b_c_d*"')
  })
  it('a comma or paren in q cannot add filters to the or list', () => {
    const f = searchOrFilter('email', 'x,id.eq.1)')!
    // Split the or list the way PostgREST does: commas outside double quotes.
    const terms: string[] = []
    let cur = ''
    let quoted = false
    for (let i = 0; i < f.length; i++) {
      const c = f[i]
      if (c === '\\' && quoted) {
        cur += c + f[++i]
        continue
      }
      if (c === '"') quoted = !quoted
      if (c === ',' && !quoted) {
        terms.push(cur)
        cur = ''
      } else cur += c
    }
    terms.push(cur)
    expect(terms).toHaveLength(7)
    for (const t of terms) expect(t).toMatch(/^(first_name|last_name|company_name|email|title|phone|city)\.ilike\."\*x,id\.eq\.1\)\*"$/)
  })
  it('covers the searched columns; two words also match first + last on email', () => {
    expect(searchOrFilter('email', '  ')).toBeNull()
    expect(searchOrFilter('email', 'acme')).toBe(
      ['first_name', 'last_name', 'company_name', 'email', 'title', 'phone', 'city'].map((c) => `${c}.ilike."*acme*"`).join(',')
    )
    expect(searchOrFilter('email', 'Jane  Doe')).toContain('and(first_name.ilike."*Jane*",last_name.ilike."*Doe*")')
    expect(searchOrFilter('linkedin', 'Jane Doe')).toMatch(/^full_name\.ilike\."\*Jane Doe\*"/)
    expect(searchOrFilter('linkedin', 'Jane Doe')).not.toContain('and(')
  })
})

describe('row → PortalLead', () => {
  it('maps an email-campaign row to exactly the contract fields', () => {
    const lead = mapEmailRow({
      id: 42, campaign_id: 'camp-1', campaign_name: 'Kaspen TX', region: 'Texas', timezone: 'America/Chicago',
      first_name: 'Jane', last_name: 'Doe', email: 'jane@acme.com', company_name: 'Acme', website: null, company_domain: 'acme.com',
      title: 'CEO', phone: '+1 555', phone_type: 'mobile', linkedin_url: 'https://li/jane', city: 'Austin', state: 'TX', country: 'US',
      email_open_count: 2, email_reply_count: 0, reply_status: 'Interested', pushed_at: '2026-01-01', finished_at: null,
    })
    expect(lead).toEqual({
      id: '42', kind: 'email', name: 'Jane Doe', first_name: 'Jane', title: 'CEO', company: 'Acme', phone: '+1 555', phone_type: 'mobile',
      email: 'jane@acme.com', website: 'acme.com', linkedin_url: 'https://li/jane', city: 'Austin', state: 'TX', country: 'US',
      region: 'Texas', timezone: 'America/Chicago', campaign: 'Kaspen TX', reply_status: 'Interested', opened: true, replied: false,
      step: '5 · In campaign',
    })
    expect(lead).not.toHaveProperty('pushed_at')
    expect(lead).not.toHaveProperty('campaign_id')
  })
  it('falls back sensibly and drops unknown enum values', () => {
    const lead = mapEmailRow({ id: 7, email: 'x@y.co', phone_type: 'fax', reply_status: 'Lost', email_open_count: 0, email_reply_count: 3 })
    expect(lead).toMatchObject({ id: '7', name: 'x@y.co', phone_type: null, reply_status: null, opened: false, replied: true })
  })
  it('maps a LinkedIn row (full_name, list title, no region/replies)', () => {
    const lead = mapLinkedinRow({ id: 'uuid-1', set_id: 'set-1', list_title: 'LI wave 1', first_name: 'Bo', last_name: 'Li', full_name: 'Bo Li', company_name: 'Z', phone: '1' })
    expect(lead).toMatchObject({ id: 'uuid-1', kind: 'linkedin', name: 'Bo Li', campaign: 'LI wave 1', region: null, timezone: null, reply_status: null, opened: false, replied: false, phone_type: null })
    expect(Object.keys(lead).sort()).toEqual(Object.keys(mapEmailRow({ id: 1 })).sort())
  })
})

describe('call-sheet rows (GTM-18)', () => {
  it('maps a Google Maps business: company as the name, company phone, rating, category, status', () => {
    const lead = mapSheetRow({
      id: 'uuid-9', set_id: 'sheet-1', list_title: 'Maps LA property managers', company_name: 'Sunset Property Mgmt', person_name: null, title: null,
      category: 'Property management company', phone: '+1 310-555-0100', website: 'https://sunsetpm.com', company_domain: 'sunsetpm.com',
      city: 'Los Angeles', state: 'CA', country: 'US', rating: 4.66, reviews_count: 120, step_label: '1 · Imported',
    })
    expect(lead).toMatchObject({
      id: 'uuid-9', kind: 'sheet', name: 'Sunset Property Mgmt', company: 'Sunset Property Mgmt', title: null, phone: '+1 310-555-0100', phone_type: 'company',
      website: 'https://sunsetpm.com', city: 'Los Angeles', campaign: 'Maps LA property managers', rating: 4.7, category: 'Property management company', step: '1 · Imported',
    })
  })
  it('a named contact goes under the business; no phone means no phone type; a bad rating is dropped', () => {
    const lead = mapSheetRow({ id: 1, company_name: 'Acme PM', person_name: 'Ana Ruiz', rating: 'n/a', company_domain: 'acme.com' })
    expect(lead).toMatchObject({ name: 'Acme PM', title: 'Ana Ruiz', phone: null, phone_type: null, rating: null, website: 'acme.com' })
  })
  it('sheet tab: reads the call-sheet view scoped to the user sheet ids, sorted by business', async () => {
    const { db, calls } = fakeDb([{ data: [{ id: 'r1', company_name: 'B' }], count: 1 }])
    const res = await searchPortalLeads(db, user, { tab: 'sheet', sort: 'name', has_phone: true })
    expect(res.rows[0]).toMatchObject({ id: 'r1', kind: 'sheet', name: 'B' })
    expect(calls[0].table).toBe('lume_portal_sheet_leads')
    expect(calls[0].ops).toContainEqual(['in', ['set_id', ['sheet-1']]])
    expect(calls[0].ops).toContainEqual(['not', ['phone', 'is', null]])
    expect(calls[0].ops.filter(([o]) => o === 'order').map(([, a]) => a[0])[0]).toBe('company_name')
  })
  it('no shared sheets → empty without a query', async () => {
    const { db, calls } = fakeDb([])
    expect((await searchPortalLeads(db, { ...user, sheet_set_ids: [] }, { tab: 'sheet' })).rows).toEqual([])
    expect(calls).toHaveLength(0)
  })
  it('the search covers the business name and category', () => {
    expect(searchOrFilter('sheet', 'sunset')).toContain('company_name.ilike')
    expect(searchOrFilter('sheet', 'sunset')).toContain('category.ilike')
  })
})

describe('scoped search', () => {
  beforeEach(() => clearPortalRegionCache())

  it('email tab: scoped to the user campaign ids, filters, sort, 50-row page', async () => {
    const { db, calls } = fakeDb([{ data: [{ id: 1, first_name: 'A' }], count: 120 }])
    const res = await searchPortalLeads(db, user, { tab: 'email', q: 'acme', has_phone: true, region: 'Texas', status: 'replied_positive', sort: 'region', page: 2 })
    expect(res).toMatchObject({ total: 120, page: 2, pageSize: 50 })
    expect(res.rows[0]).toMatchObject({ id: '1', kind: 'email' })
    const { table, ops } = calls[0]
    expect(table).toBe('lume_portal_leads')
    expect(ops).toContainEqual(['in', ['campaign_id', ['camp-1', 'camp-2']]])
    expect(ops).toContainEqual(['not', ['phone', 'is', null]])
    expect(ops).toContainEqual(['eq', ['region', 'Texas']])
    expect(ops).toContainEqual(['not', ['reply_status', 'is', null]])
    expect(ops).toContainEqual(['range', [50, 99]])
    expect(ops.filter(([o]) => o === 'order').map(([, a]) => a[0])).toEqual(['region', 'company_name', 'id'])
    const select = ops.find(([o]) => o === 'select')![1][0] as string
    expect(select).not.toMatch(/pushed_at|finished_at|campaign_id/)
  })

  it('linkedin tab: scoped to the user set ids', async () => {
    const { db, calls } = fakeDb([{ data: [], count: 0 }])
    await searchPortalLeads(db, user, { tab: 'linkedin', sort: 'name' })
    expect(calls[0].table).toBe('lume_portal_linkedin_leads')
    expect(calls[0].ops).toContainEqual(['in', ['set_id', ['set-1']]])
    expect(calls[0].ops.filter(([o]) => o === 'order').map(([, a]) => a[0])).toEqual(['full_name', 'id'])
  })

  it('no ids on a tab, or a filter that cannot match there → empty without a query', async () => {
    const { db, calls } = fakeDb([])
    expect((await searchPortalLeads(db, { ...user, campaign_ids: [] }, { tab: 'email' })).rows).toEqual([])
    expect((await searchPortalLeads(db, user, { tab: 'linkedin', status: 'replied_positive' })).total).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('pageSize is capped at 50', async () => {
    const { db, calls } = fakeDb([{ data: [], count: 0 }])
    await searchPortalLeads(db, user, { tab: 'email', pageSize: 500 })
    expect(calls[0].ops).toContainEqual(['range', [0, 49]])
  })

  it('throws on a DB error', async () => {
    const { db } = fakeDb([{ data: null, error: { message: 'boom' } }])
    await expect(searchPortalLeads(db, user, { tab: 'email' })).rejects.toThrow('boom')
  })

  it('regions: distinct, sorted, scoped, cached; none on linkedin', async () => {
    const { db, calls } = fakeDb([{ data: [{ region: 'Texas' }, { region: 'Ohio' }, { region: 'Texas' }, { region: '' }] }])
    expect(await portalRegions(db, user, 'email')).toEqual(['Ohio', 'Texas'])
    expect(calls[0].ops).toContainEqual(['in', ['campaign_id', ['camp-1', 'camp-2']]])
    expect(await portalRegions(db, user, 'email')).toEqual(['Ohio', 'Texas'])
    expect(await portalRegions(db, user, 'linkedin')).toEqual([])
    expect(calls).toHaveLength(1)
  })

  it('portalLeadsResponse combines the page and regions', async () => {
    const { db } = fakeDb([{ data: [{ id: 5 }], count: 1 }, { data: [{ region: 'Iowa' }] }])
    const body = await portalLeadsResponse(db, user, { tab: 'email', page: 1, q: undefined, region: undefined })
    expect(body).toMatchObject({ total: 1, page: 1, pageSize: 50, regions: ['Iowa'] })
  })
})
