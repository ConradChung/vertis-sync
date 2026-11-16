import { describe, expect, it } from 'vitest'
import { defaultFilters, filtersFromParams, filtersToParams, leadsApiUrl, portalHref, switchTab, withAs, type PortalFilters } from '@/components/portal/query'

describe('portal filters ↔ URL params', () => {
  it('defaults: email tab with Has phone on, nothing written to the URL', () => {
    const f = filtersFromParams(new URLSearchParams(''))
    expect(f).toEqual(defaultFilters('email'))
    expect(f.hasPhone).toBe(true)
    expect(portalHref(f)).toBe('/portal')
  })

  it('LinkedIn defaults Has phone off', () => {
    expect(filtersFromParams(new URLSearchParams('tab=linkedin')).hasPhone).toBe(false)
  })

  it('round-trips every non-default filter', () => {
    const cases: PortalFilters[] = [
      { tab: 'email', q: 'greystar', region: 'Texas', hasPhone: false, repliedPositive: true, sort: 'name', page: 3 },
      { tab: 'linkedin', q: '', region: '', hasPhone: true, repliedPositive: false, sort: 'region', page: 1 },
      defaultFilters('linkedin'),
    ]
    for (const f of cases) {
      expect(filtersFromParams(filtersToParams(f))).toEqual(f)
    }
  })

  it('carries the owner-preview `as` through', () => {
    const p = filtersToParams({ ...defaultFilters(), q: 'x' }, 'frank@getzenport.com')
    expect(p.get('as')).toBe('frank@getzenport.com')
    expect(p.get('q')).toBe('x')
  })

  it('ignores malformed values', () => {
    const f = filtersFromParams(new URLSearchParams('tab=nope&sort=evil&page=-4&has_phone=maybe'))
    expect(f).toEqual(defaultFilters('email'))
  })

  it('builds the API URL with the contract param names', () => {
    const url = leadsApiUrl({ tab: 'email', q: 'bob', region: 'TX', hasPhone: true, repliedPositive: true, sort: 'company', page: 2 }, 'a@b.co')
    const p = new URL(url, 'http://x').searchParams
    expect(url.startsWith('/api/portal/leads?')).toBe(true)
    expect(Object.fromEntries(p)).toEqual({ tab: 'email', q: 'bob', region: 'TX', has_phone: '1', status: 'replied_positive', sort: 'company', page: '2', as: 'a@b.co' })
    expect(new URL(leadsApiUrl(defaultFilters('linkedin')), 'http://x').searchParams.has('has_phone')).toBe(false)
  })

  it('tab switch keeps search/sort, resets region/page and Has phone default', () => {
    const f = switchTab({ tab: 'email', q: 'bob', region: 'TX', hasPhone: true, repliedPositive: true, sort: 'name', page: 4 }, 'linkedin')
    expect(f).toEqual({ tab: 'linkedin', q: 'bob', region: '', hasPhone: false, repliedPositive: true, sort: 'name', page: 1 })
  })

  it('withAs appends with the right separator', () => {
    expect(withAs('/api/portal/me', null)).toBe('/api/portal/me')
    expect(withAs('/api/portal/me', 'a+b@c.co')).toBe('/api/portal/me?as=a%2Bb%40c.co')
    expect(withAs('/x?y=1', 'a@c.co')).toBe('/x?y=1&as=a%40c.co')
  })
})
