import { toApolloCsv, type ApolloRecord } from '@/lib/apollo/records'
import type { ReviewRow } from '@/lib/review/model'

/** Kept rows only, in Apollo's import columns. */
export function keptApolloCsv(rows: readonly ReviewRow[]): { csv: string; rows: number } {
  const records: ApolloRecord[] = rows
    .filter((r) => r.status === 'kept')
    .map(({ item: i }) => ({
      first_name: i.first_name,
      last_name: i.last_name,
      email: i.email,
      title: i.title,
      company: i.company ?? i.name,
      domain: i.domain,
      website: i.website,
      linkedin_url: i.linkedin_url,
      city: i.city,
      state: i.state,
      country: i.country,
    }))
  return { csv: toApolloCsv(records), rows: records.length }
}
