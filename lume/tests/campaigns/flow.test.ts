import { describe, expect, it } from 'vitest'
import { buildBankStage, buildFeeders, buildStages, plainSchedule, sumCounts } from '@/lib/campaigns/flow'
import type { CampaignJob, LeadSources } from '@/lib/campaigns/types'
import type { GateRow, RotationRuleRow } from '@/lib/db/types'

const job = (o: Partial<CampaignJob>): CampaignJob => ({
  id: 'j1', filename: 'a.csv', status: 'completed', instantly_status: 'done', total_rows: 0, valid_count: 0, enrich: false,
  enriched_rows: 0, instantly_pushed: 0, created_at: '2026-10-01T00:00:00Z', ...o,
})
const SOURCES: LeadSources = {
  bank: { active: 994, queued: 993, completed: 69, replied: 2, bounced: 26, skipped: 128 },
  runs: { count: 35, pushed: 1101, first_at: '2026-10-09T07:42:51Z', last: { ran_at: '2026-10-26T01:00:19Z', pushed: 1, deleted: 1, archived: 0, in_instantly_after: 1000, note: 'rotate', errors: 0 } },
  crons: [
    { name: 'instantly-rotate-am', schedule: '0 13 * * *', active: true },
    { name: 'instantly-rotate-pm', schedule: '0 1 * * *', active: true },
  ],
}
const status = (stages: ReturnType<typeof buildStages>) => Object.fromEntries(stages.map((s) => [s.id, s.status]))

describe('sumCounts', () => {
  it('adds the lead bank and rotation numbers next to the job totals', () => {
    const c = sumCounts([job({ total_rows: 100, valid_count: 60, instantly_pushed: 50 })], { sent: 1266, replies: 4 }, SOURCES)
    expect(c).toEqual({
      imported: 100, validated: 60, enriched: 0, pushed: 50, sent: 1266, replies: 4,
      bank_total: 2212, bank_queued: 993, rotated: 1101, in_campaign: 1000,
    })
    expect(sumCounts([], null)).toMatchObject({ bank_total: 0, rotated: 0, in_campaign: null, sent: null })
  })
})

describe('buildStages', () => {
  it('rotation-only campaign: validation path unused, send current, replies lit — and every number has a source', () => {
    const counts = sumCounts([], { sent: 1266, replies: 4 }, SOURCES)
    const st = buildStages({ counts, gates: [], jobs: [], campaignStatus: 'active' })
    expect(status(st)).toEqual({ import: 'unused', validate: 'unused', enrich: 'unused', push: 'unused', send: 'active', reply: 'done' })
    expect(st[0].hint).toBe('Not used: fed by the lead bank')
    expect(st.find((s) => s.id === 'send')).toMatchObject({ label: 'Emails sent', hint: 'active · 1,000 leads in campaign' })
    expect(st.find((s) => s.id === 'send')!.source).toMatch(/^From Instantly/)
    for (const s of st) expect(s.source.length).toBeGreaterThan(10)
  })

  it('lights passed stages: enrichment skipped but pushed counts as passed', () => {
    const jobs = [job({ total_rows: 100, valid_count: 60, enriched_rows: 0, instantly_pushed: 55 })]
    const st = buildStages({ counts: sumCounts(jobs, { sent: 0, replies: 0 }), gates: [], jobs, campaignStatus: 'paused' })
    expect(status(st)).toEqual({ import: 'done', validate: 'done', enrich: 'done', push: 'done', send: 'idle', reply: 'idle' })
    expect(st[2].hint).toBe('Skipped — enrichment off')
  })

  it('an open gate makes its stage the current one; later stages stay unlit', () => {
    const jobs = [job({ id: 'J', total_rows: 100, valid_count: 0, status: 'completed' })]
    const gate = { kind: 'finder_decision', target_table: 'validation_jobs', target_id: 'J', title: 'Decide a.csv' } as unknown as GateRow
    const st = buildStages({ counts: sumCounts(jobs, null), gates: [gate], jobs, campaignStatus: 'draft' })
    expect(status(st)).toMatchObject({ import: 'done', validate: 'waiting', enrich: 'idle', push: 'idle' })
    expect(st[1].action).toEqual({ type: 'link', href: '/validate?gate=finder_decision:J', label: 'Open gate' })
  })
})

describe('bank stage and feeders', () => {
  it('bank stage summarises states', () => {
    const b = buildBankStage(sumCounts([], null, SOURCES), SOURCES)
    expect(b).toMatchObject({ id: 'bank', count: 2212, status: 'done', hint: '993 queued · 994 sending · 225 finished' })
  })

  it('pg_cron feeder: one Auto-rotation node, UTC schedule in owner time, lifetime added, last run result', () => {
    const now = new Date('2026-10-26T06:00:00Z') // PDT
    const [f] = buildFeeders([], SOURCES, now)
    expect(f).toMatchObject({
      kind: 'system',
      name: 'Auto-rotation',
      schedule: 'Daily at 6:00 AM and 6:00 PM',
      active: true,
      next_run: '2026-10-26T13:00:00.000Z',
      last_run: '2026-10-26T01:00:19Z',
      last_result: 'added 1 lead · removed 1 finished · 1,000 in campaign after',
      leads_added: 1101,
      leads_added_label: 'added over 35 runs',
      href: '/rotate',
    })
  })

  it('rotation rules become rule feeders linking to the rule on Rotate; no runs and no crons → no system feeder', () => {
    const rule = {
      id: 'r1', name: 'Weekday refill', campaign_id: 'c', filter: {}, daily_cap: 40, order_by: 'newest', cron: '0 8 * * 1-5',
      active: true, next_run_at: '2026-10-27T15:00:00Z', last_run_at: null, last_result: null, created_at: '',
    } as unknown as RotationRuleRow
    const out = buildFeeders([rule], { bank: {}, runs: { count: 0, pushed: 0, first_at: null, last: null }, crons: [] })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'rule', schedule: 'Weekdays at 8:00 AM', last_result: 'Never run', leads_added: null, leads_added_label: 'up to 40 per run', href: '/rotate#rule-r1' })
  })
})

describe('plainSchedule', () => {
  const now = new Date('2026-10-26T06:00:00Z')
  it('describes common shapes', () => {
    expect(plainSchedule(['*/15 * * * *'], 'UTC', now)).toBe('Every 15 minutes')
    expect(plainSchedule(['17 * * * *'], 'UTC', now)).toBe('Hourly at :17')
    expect(plainSchedule(['30 9 * * 1,3'], 'America/Los_Angeles', now)).toBe('On Mon, Wed at 9:30 AM')
    expect(plainSchedule(['0 0 1 * *'], 'UTC', now)).toBe('0 0 1 * * (UTC)')
    expect(plainSchedule([], 'UTC', now)).toBe('No schedule')
  })
})
