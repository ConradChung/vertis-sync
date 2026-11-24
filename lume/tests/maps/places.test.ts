import { describe, expect, it } from 'vitest'
import { cleanPlaces, cleanSummary, isPmCategory, MAPS_SHEET_COLUMNS, normalizePlace, placeDomain, sheetCsv, sheetRow } from '@/lib/maps/places'

// Shaped like compass/crawler-google-places dataset items.
const place = (o: Record<string, unknown>) => ({
  title: 'Acme Property Management',
  website: 'https://www.acmepm.com/',
  phone: '(310) 555-0134',
  phoneUnformatted: '+13105550134',
  address: '100 Main St, Santa Monica, CA 90401',
  street: '100 Main St',
  city: 'Santa Monica',
  state: 'California',
  postalCode: '90401',
  countryCode: 'US',
  totalScore: 4.6,
  reviewsCount: 120,
  categoryName: 'Property management company',
  categories: ['Property management company', 'Real estate agency'],
  permanentlyClosed: false,
  temporarilyClosed: false,
  placeId: 'ChIJacme',
  url: 'https://www.google.com/maps/place/?q=place_id:ChIJacme',
  searchString: 'property management in Santa Monica, CA',
  ...o,
})

describe('placeDomain', () => {
  it('own sites → registrable domain; social, directories and bare platforms → null', () => {
    expect(placeDomain('https://www.acmepm.com/contact')).toBe('acmepm.com')
    expect(placeDomain('http://rentals.acmepm.com')).toBe('acmepm.com')
    expect(placeDomain('https://acme.co.uk')).toBe('acme.co.uk')
    expect(placeDomain('https://www.facebook.com/acmepm')).toBeNull()
    expect(placeDomain('https://www.yelp.com/biz/acme')).toBeNull()
    expect(placeDomain('https://www.zillow.com/profile/acme')).toBeNull()
    expect(placeDomain('https://linktr.ee/acme')).toBeNull()
    expect(placeDomain(null)).toBeNull()
  })
  it('PM-software and site-builder subdomains keep the full host', () => {
    expect(placeDomain('https://acmepm.appfolio.com/listings')).toBe('acmepm.appfolio.com')
    expect(placeDomain('https://acme.managebuilding.com')).toBe('acme.managebuilding.com')
    expect(placeDomain('https://appfolio.com')).toBeNull()
  })
})

describe('normalizePlace', () => {
  it('maps the actor fields', () => {
    const p = normalizePlace(place({}))!
    expect(p).toMatchObject({ name: 'Acme Property Management', domain: 'acmepm.com', phone: '(310) 555-0134', phone_e164: '+13105550134', city: 'Santa Monica', postal_code: '90401', rating: 4.6, reviews: 120, place_id: 'ChIJacme' })
    expect(isPmCategory(p)).toBe(true)
  })
  it('no title → not a place; a bad E.164 is kept only as display text', () => {
    expect(normalizePlace({ website: 'x.com' })).toBeNull()
    const p = normalizePlace(place({ phone: null, phoneUnformatted: '310-555' }))!
    expect(p.phone).toBe('310-555')
    expect(p.phone_e164).toBeNull()
  })
})

describe('cleanPlaces', () => {
  const items = [
    place({}),
    place({ title: 'Acme PM (Pasadena office)', reviewsCount: 400, placeId: 'ChIJacme2', city: 'Pasadena' }), // same domain, more reviews: wins
    place({ title: 'Closed Co', website: 'closed.com', permanentlyClosed: true }),
    place({ title: 'No Site PM', website: null }),
    place({ title: 'FB Only PM', website: 'https://facebook.com/fbonly' }),
    place({ title: 'Bright Plumbing', website: 'brightplumb.com', categoryName: 'Plumber', categories: ['Plumber'], reviewsCount: 999 }),
    place({ title: 'Zed Realty', website: 'zedrealty.com', reviewsCount: 5, categoryName: 'Property management company' }),
    { foo: 'bar' },
  ]
  const r = cleanPlaces(items)

  it('drops closed, no website, not own website and duplicates, each counted', () => {
    expect(r.total).toBe(8)
    expect(r.dropped).toEqual({ not_a_place: 1, permanently_closed: 1, no_website: 1, not_own_website: 1, duplicate_domain: 1 })
    expect(r.kept.map((p) => p.domain)).toEqual(['acmepm.com', 'zedrealty.com', 'brightplumb.com'])
  })
  it('keeps the fuller listing of a domain and counts branches', () => {
    expect(r.kept[0]).toMatchObject({ name: 'Acme PM (Pasadena office)', reviews: 400, branches: 2 })
  })
  it('orders PM category first, then reviews', () => {
    expect(r.kept.map((p) => isPmCategory(p))).toEqual([true, true, false])
  })
  it('summarises the drops', () => {
    expect(cleanSummary(r)).toBe(
      "3 companies kept of 8 places (2 in Google's property management category); dropped 1 permanently closed, 1 without a website, 1 with only a social or directory page, 1 duplicate listings of a kept company, 1 rows that were not places.",
    )
    expect(cleanSummary(cleanPlaces([place({})]))).toBe("1 companies kept of 1 places (1 in Google's property management category).")
  })
})

describe('sheet rows', () => {
  const [acme] = cleanPlaces([place({ title: '=HYPERLINK("x")' })]).kept

  it('row: the sheet columns as cells, the E.164 phone on the lead item, lane on raw', () => {
    const row = sheetRow(acme, 'actor_run')
    expect(Object.keys(row.cells)).toEqual([...MAPS_SHEET_COLUMNS])
    expect(row.cells).toMatchObject({ Phone: '(310) 555-0134', City: 'Santa Monica', Rating: '4.6', Reviews: '120', 'Maps PM': 'yes', Branches: '1', Domain: 'acmepm.com' })
    expect(row.item).toMatchObject({ company: '=HYPERLINK("x")', phone: '+13105550134', domain: 'acmepm.com', email: null, linkedin_url: null })
    expect(row.raw.lane).toBe('gtm-12-google-maps')
    expect(row.source).toBe('actor_run')
  })

  it('CSV: header + CRLF rows, formula text neutralised', () => {
    const csv = sheetCsv([acme])
    const [head, line] = csv.split('\r\n')
    expect(head).toBe(MAPS_SHEET_COLUMNS.join(','))
    expect(line.startsWith(`"'=HYPERLINK(""x"")",(310) 555-0134,Santa Monica,`)).toBe(true)
    expect(csv.endsWith('\r\n')).toBe(true)
  })
})
