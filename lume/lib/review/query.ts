import type { ReviewRow } from '@/lib/review/model'

export interface PageQuery {
  status: 'kept' | 'excluded' | 'all'
  q?: string
  category?: string
  city?: string
  page: number
  pageSize: number
}

/** Filter + page rows for the Leads table and the review_leads tool. */
export function pageRows(rows: readonly ReviewRow[], q: PageQuery) {
  const needle = q.q?.trim().toLowerCase()
  const cat = q.category?.trim().toLowerCase()
  const city = q.city?.trim().toLowerCase()
  const hit = rows.filter((r) => {
    if (q.status !== 'all' && r.status !== q.status) return false
    if (cat && (r.item.category ?? '').toLowerCase() !== cat) return false
    if (city && (r.item.city ?? '').toLowerCase() !== city) return false
    if (needle) {
      const hay = [r.item.name, r.item.category, r.item.city, r.item.domain, r.item.email].filter(Boolean).join(' ').toLowerCase()
      if (!hay.includes(needle)) return false
    }
    return true
  })
  const pageSize = Math.min(Math.max(q.pageSize, 1), 200)
  const page = Math.max(q.page, 0)
  return { rows: hit.slice(page * pageSize, page * pageSize + pageSize), total: hit.length, page, page_size: pageSize }
}
