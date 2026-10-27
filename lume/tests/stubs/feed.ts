// Captures lume_alerts writes made through lib/alerts.ts. Use with
//   vi.mock('@/lib/supabase/service', async () => (await import('../stubs/feed')).serviceModule)
// in tests whose other DB access is mocked at '@/lib/db/service' / stores.
export interface FeedRow {
  source: string
  severity: string
  title: string
  body: string | null
  link: string | null
  campaign_id: string | null
  scope: string | null
  dedupe_key: string | null
}

export const feed = { rows: [] as FeedRow[] }

const table = {
  insert: async (row: FeedRow) => { feed.rows.push(row); return { error: null } },
  upsert: async (row: FeedRow) => { feed.rows.push(row); return { error: null } },
}

export const serviceModule = {
  createServiceClient: () => ({
    from: (name: string) => {
      if (name !== 'lume_alerts') throw new Error(`feed stub: unexpected table ${name}`)
      return table
    },
  }),
}
