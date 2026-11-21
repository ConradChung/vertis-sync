/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest'

/**
 * Read-only smoke test against the real database. Skipped unless
 * LUME_MCP_LIVE=1. Calls each read tool's body directly, so no audit row and
 * no rate-limit count is written. Prints shapes and timings, never row data.
 */
const live = process.env.LUME_MCP_LIVE === '1'
if (live) process.loadEnvFile?.('.env.local')

describe.skipIf(!live)('read tools against the live DB (read-only)', async () => {
  const { readTools } = await import('@/lib/mcp/tools/read')
  const ids: Record<string, string> = {}

  for (const def of readTools) {
    it(def.name, async () => {
      const args: Record<string, unknown> = { limit: 3 }
      const needsId = ['lume_get_validation_job', 'lume_get_deal', 'lume_get_review_set', 'lume_get_action', 'lume_get_agent_skill']
      if (needsId.includes(def.name)) {
        const key = def.name.replace('lume_get_', '')
        if (!ids[key]) return console.log(def.name, 'skipped (no id found)')
        args.id = ids[key]
        delete args.limit
      }
      if (def.name === 'lume_list_pending_actions') args.status = 'executed'
      if (def.name === 'lume_get_overview' || def.name === 'lume_get_campaign_stats') delete args.limit
      if (def.name === 'lume_get_lead_bank_summary') delete args.limit
      const t = Date.now()
      const out = await def.run(args as never)
      const ms = Date.now() - t
      const data = out.data as Record<string, unknown>
      const rows = (data?.rows as Record<string, unknown>[] | undefined) ?? []
      const first = rows[0]
      if (first?.id) {
        const map: Record<string, string> = { lume_list_validation_jobs: 'validation_job', lume_list_deals: 'deal', lume_list_review_sets: 'review_set', lume_list_pending_actions: 'action', lume_list_agent_skills: 'agent_skill' }
        if (map[def.name]) ids[map[def.name]] = String(first.id)
      }
      console.log(`${def.name} ${ms}ms keys=${Object.keys(data ?? {}).join(',')} rows=${rows.length} cursor=${data?.next_cursor ? 'yes' : 'no'} bytes=${JSON.stringify(data).length}`)
      if (def.name === 'lume_get_overview') {
        expect(ms).toBeLessThan(3000)
        const o = data as any
        console.log('overview counts', JSON.stringify({ alerts: o.alerts.unacked, urgent: o.alerts.urgent, bank: o.lead_bank, awaiting: o.pending_actions.awaiting, failed: o.failed_since, active: o.validation, rot: o.rotation }))
      }
    }, 20_000)
  }

  it('second page via cursor works', async () => {
    const ev = readTools.find((t) => t.name === 'lume_list_events')!
    const p1 = (await ev.run({ limit: 2 } as never)).data as any
    expect(p1.next_cursor).toBeTruthy()
    const p2 = (await ev.run({ limit: 2, cursor: p1.next_cursor } as never)).data as any
    expect(p2.rows[0].id).not.toBe(p1.rows[0].id)
    expect(Number(p2.rows[0].id)).toBeLessThan(Number(p1.rows[1].id))
  })
})
