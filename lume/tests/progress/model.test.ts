import { describe, expect, it } from 'vitest'
import { fromApifyRun, fromApolloOrder, fromCompanyCheckRun, fromInfluencerRun, fromJobBatch, fromLookupBatch, fromValidationJob, partitionProgress, pollInterval, withTagNames } from '@/lib/progress/model'

const NOW = Date.parse('2026-11-06T12:00:00Z')
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString()

describe('progress items', () => {
  it('validation job: stage from what it is doing, done / total of that stage, ETA, link to its gates', () => {
    const base = { id: 'j1', filename: 'pm.csv', status: 'processing', total_rows: 5272, processed_rows: 153, valid_count: 120, invalid_count: 30, enrich: true, enrich_started: false, enriched_rows: 0, instantly_status: 'idle', eta_seconds: 3600, eta_updated_at: iso(1), eta_stage: 'validating', created_at: iso(120), updated_at: iso(1), error_message: null }
    expect(fromValidationJob(base)).toMatchObject({ key: 'validation:j1', kind: 'validation', label: 'Validation', title: expect.stringMatching(/^5,272 leads · /), stage: 'validating', done: 153, total: 5272, eta_seconds: 3600, finished: false, href: '/runs/validation/j1', job_id: 'j1' })
    expect(fromValidationJob({ ...base, processed_rows: 5272, enrich_started: true, enriched_rows: 40 })).toMatchObject({ stage: 'enriching (city)', done: 40, total: 120 })
    expect(fromValidationJob({ ...base, processed_rows: 5272, instantly_status: 'pushing' })).toMatchObject({ stage: 'pushing' })
    expect(fromValidationJob({ ...base, processed_rows: 5272 })).toMatchObject({ stage: 'retry pass' })
    expect(fromValidationJob({ ...base, status: 'failed', error_message: 'MailTester: Disabled Key' })).toMatchObject({ finished: true, error: 'MailTester: Disabled Key' })
  })

  it('Apify run: items and cost so far, the console link', () => {
    expect(fromApifyRun({ id: 'r1', actorId: 'compass/x', status: 'RUNNING', startedAt: iso(5), finishedAt: null, usageTotalUsd: 0.42, itemCount: 120, consoleUrl: 'https://console.apify.com/r1', statusMessage: null })).toMatchObject({
      key: 'apify:r1', kind: 'apify', label: 'Apify run', title: 'compass/x', status: 'running', done: 120, total: null, cost_usd: 0.42, href: '/runs/apify/r1', external: false, finished: false,
    })
    expect(fromApifyRun({ id: 'r2', actorId: null, status: 'FAILED', startedAt: iso(50), finishedAt: iso(40), usageTotalUsd: null, itemCount: null, consoleUrl: 'u', statusMessage: 'boom' })).toMatchObject({ finished: true, error: 'boom' })
  })

  it('influencer reaction run: stage and cost; awaiting approval counts as live', () => {
    expect(fromInfluencerRun({ id: 'ir', status: 'awaiting_approval', stage: 'reactions', influencer_ids: ['a', 'b'], cost: { total_usd: 1.2 }, counts: {}, error: null, created_at: iso(30), updated_at: iso(2), finished_at: null })).toMatchObject({
      kind: 'influencer_run', label: 'Influencer run', title: '2 influencers', status: 'awaiting approval', stage: 'reactions', cost_usd: 1.2, finished: false, href: '/runs/influencer_run/ir',
    })
  })

  it('influencer run Open: always that run, whatever its status or approvals', () => {
    const r = { id: 'ir', status: 'awaiting_approval', stage: 'reactions', influencer_ids: ['a'], cost: null, counts: {}, error: null, created_at: iso(3), updated_at: iso(2), finished_at: null }
    expect(fromInfluencerRun({ ...r, start_action_id: 'start-1' }).href).toBe('/runs/influencer_run/ir')
    expect(fromInfluencerRun({ ...r, status: 'running', start_action_id: 'start-1', reactions_action_id: 'rx-1' }).href).toBe('/runs/influencer_run/ir')
    expect(fromInfluencerRun({ ...r, status: 'done', counts: { candidates: 4 }, start_action_id: 'start-1' }).href).toBe('/runs/influencer_run/ir')
  })

  it('LinkedIn lookup: done / total and $ spent of the cap; Open goes to the lookup', () => {
    expect(fromLookupBatch({ id: 'b', name: 'PM Influencers', status: 'looking_up', spent_usd: '0.40', max_lookup_usd: '1.19', created_at: iso(10), updated_at: iso(1), error: null }, { pending_lookup: 40, found: 65, not_found: 7, approved: 21 }, 'list-1')).toMatchObject({
      kind: 'influencer_lookup', title: 'PM Influencers', done: 93, total: 133, cost_usd: 0.4, cap_usd: 1.19, href: '/runs/influencer_lookup/b', finished: false,
    })
  })

  it('Leadsfriday order and job-search batch: their stage, Open goes to that order / batch', () => {
    expect(fromApolloOrder({ id: 'o', status: 'ordered', contact_count: 500, leadsfriday_status: 'processing', error: null, created_at: iso(60), updated_at: iso(5) })).toMatchObject({ kind: 'leadsfriday_order', title: '500 contacts', stage: 'processing', finished: false, href: '/runs/leadsfriday_order/o' })
    expect(fromJobBatch({ id: 'jb', status: 'resolving', batch_date: '2026-11-06', companies_pulled: 40, companies_added: 12, contacts_total: null, error: null, created_at: iso(60), updated_at: iso(5) })).toMatchObject({ kind: 'job_batch', stage: 'resolving', done: 12, total: 40, finished: false, href: '/runs/job_batch/jb' })
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

describe('withTagNames', () => {
  const V = [
    { id: 'v-jobs', name: 'Job search / GTM roles', key: 'jobs' },
    { id: 'v-pm', name: 'PM reactions', key: 'pm_reactions' },
  ]
  const at = '2026-11-06T12:00:00Z'
  it('names tagged items, keeps untagged ones, and marks influencer work PM reactions (read-only)', () => {
    const batch = fromJobBatch({ id: 'b', status: 'ordered', batch_date: null, companies_pulled: 1, companies_added: 1, contacts_total: null, error: null, created_at: at, updated_at: at, vertical_id: 'v-jobs' })
    const order = fromApolloOrder({ id: 'o', status: 'ordered', contact_count: 500, leadsfriday_status: null, error: null, created_at: at, updated_at: at })
    const run = fromInfluencerRun({ id: 'r', status: 'running', stage: null, influencer_ids: [], cost: null, counts: null, error: null, created_at: at, updated_at: at, finished_at: null })
    const [b, o, r] = withTagNames([batch, order, run], V)
    expect(b).toMatchObject({ vertical_id: 'v-jobs', vertical_name: 'Job search / GTM roles', tag_table: 'job_batches' })
    expect(o).toMatchObject({ vertical_id: null, tag_table: 'apollo_orders' })
    expect(r).toMatchObject({ vertical_id: 'v-pm', vertical_name: 'PM reactions', tag_table: null })
  })
})

describe('fromCompanyCheckRun', () => {
  it('settled companies of the total, spend vs cap, finished unless running', () => {
    const now = new Date().toISOString()
    const r = { id: 'r', job_id: 'j', job_name: 'leadsfriday-4445.csv', status: 'running', companies_total: 3140, spent_usd: '1.2', max_usd: '24.01', error: null, created_at: now, updated_at: now }
    expect(fromCompanyCheckRun(r, { pending: 3000, done: 120, cached: 20 })).toMatchObject({
      key: 'company_check:r', kind: 'company_check', title: 'leadsfriday-4445.csv', done: 140, total: 3140, cost_usd: 1.2, cap_usd: 24.01, finished: false, job_id: 'j', href: '/runs/company_check/r', external: false,
    })
    expect(fromCompanyCheckRun({ ...r, status: 'done' }, {}).finished).toBe(true)
    expect(fromCompanyCheckRun({ ...r, status: 'done' }, {}).total).toBe(3140)
  })
})

describe('Open links', () => {
  const at = '2026-11-06T12:00:00Z'
  it('every kind opens its own run at /runs/<kind>/<row id>, never a shared tab', () => {
    const items = [
      fromValidationJob({ id: 'j1', filename: 'a.csv', status: 'done', total_rows: 1, processed_rows: 1, created_at: at, updated_at: at, error_message: null }),
      fromApifyRun({ id: 'HG7ML7M8z78YcAPEB', actorId: 'a/b', status: 'SUCCEEDED', startedAt: at, finishedAt: at, usageTotalUsd: 0, itemCount: 0, consoleUrl: 'https://console.apify.com/x', statusMessage: null }),
      fromInfluencerRun({ id: 'ir', status: 'done', stage: 'output', influencer_ids: [], cost: null, counts: { candidates: 3 }, error: null, created_at: at, updated_at: at, finished_at: at, start_action_id: 's' }),
      fromLookupBatch({ id: 'lb', name: 'x', status: 'done', spent_usd: 0, max_lookup_usd: null, error: null, created_at: at, updated_at: at }, {}, 'list-1'),
      fromCompanyCheckRun({ id: 'cc', job_id: 'j', job_name: null, status: 'done', companies_total: 1, spent_usd: 0, max_usd: 1, error: null, created_at: at, updated_at: at }, {}),
      fromApolloOrder({ id: 'o', status: 'ingested', contact_count: 1, leadsfriday_status: null, error: null, created_at: at, updated_at: at }),
      fromJobBatch({ id: 'jb', status: 'written', batch_date: null, companies_pulled: 0, companies_added: 0, contacts_total: 0, error: null, created_at: at, updated_at: at }),
    ]
    for (const i of items) {
      expect(i.href).toBe(`/runs/${i.kind}/${i.key.slice(i.key.indexOf(':') + 1)}`)
      expect(i.external).toBe(false)
    }
  })
})
