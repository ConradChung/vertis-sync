import { describe, expect, it } from 'vitest'
import { fromApifyRun, fromApolloOrder, fromInfluencerRun, fromJobBatch, fromLookupBatch, fromValidationJob, partitionProgress, pollInterval } from '@/lib/progress/model'

const NOW = Date.parse('2026-11-06T12:00:00Z')
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString()

describe('progress items', () => {
  it('validation job: stage from what it is doing, done / total of that stage, ETA, link to its gates', () => {
    const base = { id: 'j1', filename: 'pm.csv', status: 'processing', total_rows: 5272, processed_rows: 153, valid_count: 120, invalid_count: 30, enrich: true, enrich_started: false, enriched_rows: 0, instantly_status: 'idle', eta_seconds: 3600, eta_updated_at: iso(1), eta_stage: 'validating', created_at: iso(120), updated_at: iso(1), error_message: null }
    expect(fromValidationJob(base)).toMatchObject({ key: 'validation:j1', kind: 'validation', label: 'Validation', title: expect.stringMatching(/^5,272 leads · /), stage: 'validating', done: 153, total: 5272, eta_seconds: 3600, finished: false, href: '/progress?job=j1', job_id: 'j1' })
    expect(fromValidationJob({ ...base, processed_rows: 5272, enrich_started: true, enriched_rows: 40 })).toMatchObject({ stage: 'enriching (city)', done: 40, total: 120 })
    expect(fromValidationJob({ ...base, processed_rows: 5272, instantly_status: 'pushing' })).toMatchObject({ stage: 'pushing' })
    expect(fromValidationJob({ ...base, processed_rows: 5272 })).toMatchObject({ stage: 'retry pass' })
    expect(fromValidationJob({ ...base, status: 'failed', error_message: 'MailTester: Disabled Key' })).toMatchObject({ finished: true, error: 'MailTester: Disabled Key' })
  })

  it('Apify run: items and cost so far, the console link', () => {
    expect(fromApifyRun({ id: 'r1', actorId: 'compass/x', status: 'RUNNING', startedAt: iso(5), finishedAt: null, usageTotalUsd: 0.42, itemCount: 120, consoleUrl: 'https://console.apify.com/r1', statusMessage: null })).toMatchObject({
      key: 'apify:r1', kind: 'apify', label: 'Apify run', title: 'compass/x', status: 'running', done: 120, total: null, cost_usd: 0.42, href: 'https://console.apify.com/r1', external: true, finished: false,
    })
    expect(fromApifyRun({ id: 'r2', actorId: null, status: 'FAILED', startedAt: iso(50), finishedAt: iso(40), usageTotalUsd: null, itemCount: null, consoleUrl: 'u', statusMessage: 'boom' })).toMatchObject({ finished: true, error: 'boom' })
  })

  it('influencer reaction run: stage and cost; awaiting approval counts as live', () => {
    expect(fromInfluencerRun({ id: 'ir', status: 'awaiting_approval', stage: 'reactions', influencer_ids: ['a', 'b'], cost: { total_usd: 1.2 }, counts: {}, error: null, created_at: iso(30), updated_at: iso(2), finished_at: null })).toMatchObject({
      kind: 'influencer_run', label: 'Influencer run', title: '2 influencers', status: 'awaiting approval', stage: 'reactions', cost_usd: 1.2, finished: false, href: '/import/leads',
    })
  })

  it('LinkedIn lookup: done / total and $ spent of the cap; the sheet in Leads', () => {
    expect(fromLookupBatch({ id: 'b', name: 'PM Influencers', status: 'looking_up', spent_usd: '0.40', max_lookup_usd: '1.19', created_at: iso(10), updated_at: iso(1), error: null }, { pending_lookup: 40, found: 65, not_found: 7, approved: 21 }, 'list-1')).toMatchObject({
      kind: 'influencer_lookup', title: 'PM Influencers', done: 93, total: 133, cost_usd: 0.4, cap_usd: 1.19, href: '/import/leads?list=list-1', finished: false,
    })
  })

  it('Leadsfriday order and job-search batch: their stage, link to Import', () => {
    expect(fromApolloOrder({ id: 'o', status: 'ordered', contact_count: 500, leadsfriday_status: 'processing', error: null, created_at: iso(60), updated_at: iso(5) })).toMatchObject({ kind: 'leadsfriday_order', title: '500 contacts', stage: 'processing', finished: false, href: '/import' })
    expect(fromJobBatch({ id: 'jb', status: 'resolving', batch_date: '2026-11-06', companies_pulled: 40, companies_added: 12, contacts_total: null, error: null, created_at: iso(60), updated_at: iso(5) })).toMatchObject({ kind: 'job_batch', stage: 'resolving', done: 12, total: 40, finished: false })
  })
})

describe('partitionProgress / pollInterval', () => {
  it('running newest first; finished within 24 h newest update first; older finished dropped', () => {
    const a = { key: 'a', finished: false, started_at: iso(30), updated_at: iso(1) }
    const b = { key: 'b', finished: false, started_at: iso(5), updated_at: iso(1) }
    const c = { key: 'c', finished: true, started_at: iso(100), updated_at: iso(60) }
    const d = { key: 'd', finished: true, started_at: iso(3000), updated_at: iso(2000) }
    const p = partitionProgress([a, b, c, d] as never, NOW)
    expect(p.running.map((x) => x.key)).toEqual(['b', 'a'])
    expect(p.recent.map((x) => x.key)).toEqual(['c'])
    expect(pollInterval({ running: [a] } as never)).toBe(5_000)
    expect(pollInterval({ running: [] } as never)).toBe(60_000)
  })
})
