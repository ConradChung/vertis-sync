// Captures lume_alerts writes (lume_alert_upsert RPC calls) made through lib/alerts.ts. Use with
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
  mode?: string
  /** Present only when the alert is owner-only. */
  owner_only?: true
}

export const feed = { rows: [] as FeedRow[] }

export const serviceModule = {
  createServiceClient: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      if (fn !== 'lume_alert_upsert') throw new Error(`feed stub: unexpected rpc ${fn}`)
      feed.rows.push({
        source: args.p_source as string,
        severity: args.p_severity as string,
        title: args.p_title as string,
        body: (args.p_body ?? null) as string | null,
        link: (args.p_link ?? null) as string | null,
        campaign_id: (args.p_campaign_id ?? null) as string | null,
        scope: (args.p_scope ?? null) as string | null,
        dedupe_key: (args.p_dedupe_key ?? null) as string | null,
        mode: args.p_mode as string,
        ...(args.p_owner_only === true ? { owner_only: true as const } : {}),
      })
      const result = Promise.resolve({ error: null })
      return { abortSignal: () => result, then: result.then.bind(result) }
    },
  }),
}
