import type { PortalSort, PortalTab } from '@/lib/portal/types'

/** The portal's filter state. The page URL is its source of truth (shareable, back button). */
export interface PortalFilters {
  tab: PortalTab
  q: string
  region: string
  hasPhone: boolean
  repliedPositive: boolean
  sort: PortalSort
  page: number
}

const SORTS: readonly PortalSort[] = ['company', 'name', 'region']

/** "Has phone" is on by default where Frank is calling (email campaigns, call sheets), off on LinkedIn. */
export const defaultHasPhone = (tab: PortalTab) => tab !== 'linkedin'

export function defaultFilters(tab: PortalTab = 'email'): PortalFilters {
  return { tab, q: '', region: '', hasPhone: defaultHasPhone(tab), repliedPositive: false, sort: 'company', page: 1 }
}

interface ParamsLike {
  get(name: string): string | null
}

/** Page URL params → filters. Unknown / malformed values fall back to defaults. */
export function filtersFromParams(params: ParamsLike): PortalFilters {
  const raw = params.get('tab')
  const tab: PortalTab = raw === 'linkedin' || raw === 'sheet' ? raw : 'email'
  const d = defaultFilters(tab)
  const hp = params.get('has_phone')
  const sort = params.get('sort') as PortalSort | null
  const page = Number.parseInt(params.get('page') ?? '', 10)
  return {
    tab,
    q: params.get('q')?.trim() ? (params.get('q') as string) : '',
    region: params.get('region') ?? '',
    hasPhone: hp === '1' ? true : hp === '0' ? false : d.hasPhone,
    repliedPositive: params.get('status') === 'replied_positive',
    sort: sort && SORTS.includes(sort) ? sort : d.sort,
    page: Number.isFinite(page) && page > 1 ? page : 1,
  }
}

/**
 * Filters → page URL params. Only non-defaults are written so URLs stay short;
 * `as` (owner preview) is carried through untouched.
 */
export function filtersToParams(f: PortalFilters, as?: string | null): URLSearchParams {
  const p = new URLSearchParams()
  if (as) p.set('as', as)
  if (f.tab !== 'email') p.set('tab', f.tab)
  if (f.q.trim()) p.set('q', f.q.trim())
  if (f.region) p.set('region', f.region)
  if (f.hasPhone !== defaultHasPhone(f.tab)) p.set('has_phone', f.hasPhone ? '1' : '0')
  if (f.repliedPositive) p.set('status', 'replied_positive')
  if (f.sort !== 'company') p.set('sort', f.sort)
  if (f.page > 1) p.set('page', String(f.page))
  return p
}

/** `/portal?…` for the given filters. */
export function portalHref(f: PortalFilters, as?: string | null): string {
  const qs = filtersToParams(f, as).toString()
  return qs ? `/portal?${qs}` : '/portal'
}

/** Appends `as` to a portal API path when the owner is previewing. */
export function withAs(path: string, as?: string | null): string {
  if (!as) return path
  return `${path}${path.includes('?') ? '&' : '?'}as=${encodeURIComponent(as)}`
}

/** `GET /api/portal/leads` URL for the given filters (the API's own param names). */
export function leadsApiUrl(f: PortalFilters, as?: string | null): string {
  const p = new URLSearchParams()
  p.set('tab', f.tab)
  if (f.q.trim()) p.set('q', f.q.trim())
  if (f.region) p.set('region', f.region)
  if (f.hasPhone) p.set('has_phone', '1')
  if (f.repliedPositive) p.set('status', 'replied_positive')
  p.set('sort', f.sort)
  p.set('page', String(f.page))
  if (as) p.set('as', as)
  return `/api/portal/leads?${p.toString()}`
}

/** The filters a tab switch lands on: search, sort and the replied toggle carry over; region and page reset. */
export function switchTab(f: PortalFilters, tab: PortalTab): PortalFilters {
  return { ...f, tab, region: '', hasPhone: defaultHasPhone(tab), page: 1 }
}
