import { describe, expect, it, vi } from 'vitest'
import { runHiringTick } from '@/lib/hiring/engine'
import { ARTICLE, JOB_COORDINATOR, JOB_LEADERSHIP, JOB_OFF_TARGET } from './fixtures'
import { deps, fakeAi, fakeApify, memoryStore } from './memoryStore'

const NOW = new Date('2026-11-23T20:00:00Z')
const LATER = new Date('2026-11-23T20:30:00Z')

describe('runHiringTick: start → read → process → rows', () => {
  it('starts the due hiring lane with its run cap, then reads, checks, drafts and shows rows', async () => {
    const m = memoryStore()
    const apify = fakeApify({ ds_apr1: [JOB_COORDINATOR, JOB_LEADERSHIP, JOB_OFF_TARGET, JOB_COORDINATOR] })
    const ai = fakeAi()

    const t1 = await runHiringTick(NOW, null, deps(m, apify, ai))
    expect(t1.ok).toBe(true)
    expect(t1.started).toEqual([{ lane: 'hiring', variant: 'default', run_id: 1, apify_run_id: 'apr1', cap_usd: 2 }])
    expect(apify.startRun).toHaveBeenCalledWith('curious_coder/linkedin-jobs-scraper', expect.objectContaining({ scrapeCompany: true }), { timeout: 900, maxItems: 200, maxTotalChargeUsd: 2 })
    expect(m.spend).toEqual([expect.objectContaining({ kind: 'apify', usd: 2, status: 'reserved', run_id: 1 })])
    expect(t1.month_to_date_usd).toBe(2)

    // Still running: nothing read, and no second run (one in flight).
    const t2 = await runHiringTick(NOW, { lane: 'hiring', force: true } as never, deps(m, apify, ai))
    expect(t2.started).toEqual([])
    expect(t2.not_started).toEqual([{ lane: 'hiring', reason: 'in_flight' }])

    apify.status.apr1 = { status: 'SUCCEEDED', usageTotalUsd: 0.31 }
    m.setNow(LATER.toISOString())
    const t3 = await runHiringTick(LATER, null, deps(m, apify, ai))
    expect(t3.read).toEqual([{ run_id: 1, status: 'read', items: 4, inserted: 2 }]) // off-target dropped, duplicate job id deduped
    expect(m.runs[0]).toMatchObject({ status: 'read', cost_usd: 0.31, inserted: 2 })
    expect(m.spend.find((s) => s.kind === 'apify')).toMatchObject({ usd: 0.31, status: 'settled' })
    expect(t3.processed).toEqual({ shown: 2, skipped: 0, needs_edit: 0, deferred: 0, errors: 0 })

    const coord = m.rows.find((r) => r.role_tier === 'coordinator')!
    expect(coord).toMatchObject({ stage: 'done', skip_reason: null, pm_fit: 'fit', company_phone: '(512) 555-0142', draft_status: 'ready', draft_subject: 'leasing coordinator role' })
    expect(ai.checkCompany).toHaveBeenCalledTimes(2)
    expect(m.spend.filter((s) => s.kind === 'check')).toHaveLength(2)
    expect(m.spend.filter((s) => s.kind === 'draft')).toHaveLength(2)
    expect(t3.month_to_date_usd).toBeCloseTo(0.31 + 2 * 0.007 + 2 * 0.001, 6)
  })

  it('a grounded door count from the company check rides on the row and in the check cache; a company with none stays null', async () => {
    const m = memoryStore()
    const apify = fakeApify({ ds_apr1: [JOB_COORDINATOR, JOB_LEADERSHIP] })
    let n = 0
    const ai = fakeAi({
      checkCompany: vi.fn(async () => ({
        check: { icp_fit: 'fit' as const, property_type: 'residential', evidence: 'Manages rentals', phone: null, website: null, ...(n++ === 0 ? { door_count: 1200, door_count_source: 'https://x.com/about', door_count_confidence: 'high' as const } : {}) },
        usd: 0.007,
      })),
    })
    await runHiringTick(NOW, null, deps(m, apify, ai))
    apify.status.apr1 = { status: 'SUCCEEDED', usageTotalUsd: 0.1 }
    m.setNow(LATER.toISOString())
    await runHiringTick(LATER, null, deps(m, apify, ai))
    const withCount = m.rows.filter((r) => r.door_count === 1200)
    expect(withCount).toHaveLength(1)
    expect(withCount[0]).toMatchObject({ door_count_source: 'https://x.com/about', door_count_confidence: 'high', stage: 'done', skip_reason: null })
    expect(m.rows.filter((r) => !r.door_count)).toHaveLength(1)
    expect([...m.checks.values()].filter((c) => c.door_count === 1200)).toHaveLength(1)
  })

  it('a second ingest of the same job ids inserts nothing (dedupe_key)', async () => {
    const m = memoryStore()
    const apify = fakeApify({ ds_apr1: [JOB_COORDINATOR], ds_apr2: [JOB_COORDINATOR] })
    const ai = fakeAi()
    await runHiringTick(NOW, null, deps(m, apify, ai))
    apify.status.apr1 = { status: 'SUCCEEDED', usageTotalUsd: 0.1 }
    await runHiringTick(LATER, null, deps(m, apify, ai))
    await runHiringTick(LATER, { lane: 'hiring' }, deps(m, apify, ai))
    apify.status.apr2 = { status: 'SUCCEEDED', usageTotalUsd: 0.1 }
    const t = await runHiringTick(LATER, null, deps(m, apify, ai))
    expect(t.read).toEqual([{ run_id: expect.any(Number), status: 'read', items: 1, inserted: 0 }])
    expect(m.rows).toHaveLength(1)
  })

  it('a failed Apify run is marked failed and its spend settled', async () => {
    const m = memoryStore()
    const apify = fakeApify()
    await runHiringTick(NOW, null, deps(m, apify, fakeAi()))
    apify.status.apr1 = { status: 'FAILED', usageTotalUsd: 0.02 }
    const t = await runHiringTick(LATER, null, deps(m, apify, fakeAi()))
    expect(t.read).toEqual([{ run_id: 1, status: 'failed', items: 0, inserted: 0 }])
    expect(m.runs[0].status).toBe('failed')
    expect(m.spend[0]).toMatchObject({ usd: 0.02, status: 'settled' })
  })

  it('a startRun error frees the claim and the reservation', async () => {
    const m = memoryStore()
    const apify = fakeApify()
    apify.startRun = async () => {
      throw new Error('upstream 500')
    }
    const t = await runHiringTick(NOW, null, deps(m, apify, fakeAi()))
    expect(t.ok).toBe(false)
    expect(m.runs[0].status).toBe('failed')
    expect(m.spend[0].status).toBe('released')
    expect(t.month_to_date_usd).toBe(0)
  })
})

describe('caps', () => {
  it('will not start when month-to-date + run cap > $40, and stores one notice (dry run: not sent)', async () => {
    const m = memoryStore()
    await m.store.addSpend({ lane: 'hiring', kind: 'check', usd: 38.5, status: 'settled' })
    const apify = fakeApify()
    const t = await runHiringTick(NOW, null, deps(m, apify, fakeAi()))
    expect(apify.startRun).not.toHaveBeenCalled()
    expect(t.not_started).toEqual([{ lane: 'hiring', reason: 'monthly_cap' }])
    expect([...m.notices.entries()]).toEqual([['hiring:cap:2026-11', expect.objectContaining({ status: 'dry_run' })]])
  })

  it('live config queues the notice for the existing #sales notice poster', async () => {
    const m = memoryStore({ dry_run: false, lanes: { hiring: true } })
    await m.store.addSpend({ lane: 'hiring', kind: 'check', usd: 39, status: 'settled' })
    await runHiringTick(NOW, null, deps(m, fakeApify(), fakeAi()))
    expect(m.notices.get('hiring:cap:2026-11')?.status).toBe('pending')
  })

  it('the manual override still respects the monthly cap', async () => {
    const m = memoryStore()
    await m.store.addSpend({ lane: 'hiring', kind: 'check', usd: 39.8, status: 'settled' })
    const apify = fakeApify()
    const t = await runHiringTick(NOW, { lane: 'hiring', run_cap_usd: 0.5, max_items: 25 }, deps(m, apify, fakeAi()))
    expect(apify.startRun).not.toHaveBeenCalled()
    expect(t.not_started[0].reason).toBe('monthly_cap')
  })

  it('a check that would pass the cap leaves the row pending and stops the tick', async () => {
    const m = memoryStore()
    const apify = fakeApify({ ds_apr1: [JOB_COORDINATOR] })
    const ai = fakeAi()
    await runHiringTick(NOW, null, deps(m, apify, ai))
    apify.status.apr1 = { status: 'SUCCEEDED', usageTotalUsd: 2 }
    await m.store.addSpend({ lane: 'hiring', kind: 'check', usd: 37.995, status: 'settled' })
    const t = await runHiringTick(LATER, null, deps(m, apify, ai))
    expect(ai.checkCompany).not.toHaveBeenCalled()
    expect(t.processed.deferred).toBe(1)
    expect(m.rows[0]).toMatchObject({ stage: 'pending', locked_until: null })
  })
})

describe('schedule and manual override', () => {
  it('lanes that are off never start on schedule; the manual override starts one run of any lane', async () => {
    const m = memoryStore({ dry_run: true, lanes: { hiring: false } })
    const apify = fakeApify()
    const t1 = await runHiringTick(NOW, null, deps(m, apify, fakeAi()))
    expect(t1.started).toEqual([])
    const t2 = await runHiringTick(NOW, { lane: 'hiring', run_cap_usd: 0.5, max_items: 25 }, deps(m, apify, fakeAi()))
    expect(t2.started).toEqual([expect.objectContaining({ lane: 'hiring', cap_usd: 0.5 })])
    expect(apify.startRun).toHaveBeenCalledWith('curious_coder/linkedin-jobs-scraper', expect.objectContaining({ limitPerSource: 7 }), { timeout: 900, maxItems: 25, maxTotalChargeUsd: 0.5 })
    expect(m.runs[0].manual).toBe(true)
  })

  it('a lane that ran today is not due again until tomorrow', async () => {
    const m = memoryStore()
    const apify = fakeApify()
    await runHiringTick(NOW, null, deps(m, apify, fakeAi()))
    apify.status.apr1 = { status: 'SUCCEEDED', usageTotalUsd: 0 }
    await runHiringTick(LATER, null, deps(m, apify, fakeAi()))
    const t = await runHiringTick(new Date('2026-11-24T06:00:00Z'), null, deps(m, apify, fakeAi()))
    expect(t.started).toEqual([])
    const t2 = await runHiringTick(new Date('2026-11-24T20:00:00Z'), null, deps(m, apify, fakeAi()))
    expect(t2.started).toHaveLength(1)
  })

  it('expansion runs one run per edition, splitting the cap, and extracts each article with Haiku', async () => {
    const m = memoryStore({ dry_run: true, lanes: { expansion: true } })
    const apify = fakeApify({ ds_apr1: [ARTICLE, { title: 'x' }] })
    const ai = fakeAi()
    const t = await runHiringTick(NOW, null, deps(m, apify, ai))
    expect(t.started.map((s) => [s.variant, s.cap_usd])).toEqual([['US:en', 0.5], ['CA:en', 0.5]])
    apify.status.apr1 = { status: 'SUCCEEDED', usageTotalUsd: 0.05 }
    await runHiringTick(LATER, null, deps(m, apify, ai))
    expect(ai.extract).toHaveBeenCalledTimes(1)
    expect(m.rows[0]).toMatchObject({ signal: 'expansion', company_name: 'Evernest', company_domain: 'evernest.co', draft_status: 'ready' })
  })
})

describe('exclusions, PM check and drafts', () => {
  async function oneRow(setup: (m: ReturnType<typeof memoryStore>) => void, ai = fakeAi(), items: Record<string, unknown>[] = [JOB_COORDINATOR]) {
    const m = memoryStore()
    setup(m)
    const apify = fakeApify({ ds_apr1: items })
    await runHiringTick(NOW, null, deps(m, apify, ai))
    apify.status.apr1 = { status: 'SUCCEEDED', usageTotalUsd: 0.1 }
    const t = await runHiringTick(LATER, null, deps(m, apify, ai))
    return { m, t, ai }
  }

  it('a company in an Instantly campaign is kept for audit with skip_reason, never checked', async () => {
    const { m, ai } = await oneRow((m) => m.setLead({ domains: new Map([['sunbeltpm.com', 'in_campaign']]), names: new Map() }))
    expect(m.rows[0]).toMatchObject({ stage: 'done', skip_reason: 'in_campaign' })
    expect(ai.checkCompany).not.toHaveBeenCalled()
  })

  it('a company in the lead bank by normalised name (no domain) is skipped', async () => {
    const { m } = await oneRow(
      (m) => m.setLead({ domains: new Map(), names: new Map([['sunbelt property management', 'in_lead_bank']]) }),
      fakeAi(),
      [{ ...JOB_COORDINATOR, companyWebsite: undefined }]
    )
    expect(m.rows[0]).toMatchObject({ skip_reason: 'in_lead_bank', company_domain: null })
  })

  it('the check finding a website re-runs the exclusion on that domain', async () => {
    const { m } = await oneRow((m) => m.setLead({ domains: new Map([['sunbeltpm.com', 'in_lead_bank']]), names: new Map() }), fakeAi(), [{ ...JOB_COORDINATOR, companyWebsite: undefined }])
    expect(m.rows[0]).toMatchObject({ skip_reason: 'in_lead_bank', company_domain: 'sunbeltpm.com' })
  })

  it('not a PM company → not_pm; unclear → pm_unclear; the check is cached per domain', async () => {
    const ai = fakeAi({ checkCompany: async () => ({ check: { icp_fit: 'not_fit', property_type: 'other', evidence: 'A software vendor', phone: null, website: null }, usd: 0.007 }) })
    const { m } = await oneRow(() => {}, ai)
    expect(m.rows[0]).toMatchObject({ skip_reason: 'not_pm', pm_fit: 'not_fit' })
    expect(m.rows[0].draft_status).toBeUndefined()
    expect(m.checks.get('sunbeltpm.com')?.icp_fit).toBe('not_fit')

    const unclear = fakeAi({ checkCompany: async () => ({ check: { icp_fit: 'unclear', property_type: 'unknown', evidence: '', phone: null, website: null }, usd: 0.007 }) })
    const u = await oneRow(() => {}, unclear)
    expect(u.m.rows[0]).toMatchObject({ skip_reason: 'pm_unclear', pm_fit: 'unclear' })
  })

  it('a cached company check is reused (no second Perplexity call)', async () => {
    const ai = fakeAi()
    const { m } = await oneRow((m) => void m.checks.set('sunbeltpm.com', { icp_fit: 'fit', property_type: 'residential', evidence: 'cached', phone: null, website: null }), ai)
    expect(ai.checkCompany).not.toHaveBeenCalled()
    expect(m.rows[0]).toMatchObject({ pm_fit: 'fit', pm_evidence: 'cached', draft_status: 'ready' })
  })

  it('two ads from one company: the second is a duplicate_company', async () => {
    const { m, ai } = await oneRow(() => {}, fakeAi(), [JOB_COORDINATOR, { ...JOB_COORDINATOR, id: '999', title: 'Maintenance Coordinator' }])
    expect(m.rows.map((r) => r.skip_reason)).toEqual([null, 'duplicate_company'])
    expect(ai.draft).toHaveBeenCalledTimes(1)
  })

  it('a draft that fails the SOP lint is stored as needs_edit with the violations', async () => {
    const ai = fakeAi({ draft: async () => ({ draft: { subject: 'Hello There Friend', body: 'We manage 5,000 doors! Quick call?\n\nFrank' }, usd: 0.001 }) })
    const { m, t } = await oneRow(() => {}, ai)
    expect(t.processed.needs_edit).toBe(1)
    expect(m.rows[0]).toMatchObject({ skip_reason: null, draft_status: 'needs_edit', draft_subject: 'Hello There Friend' })
    expect((m.rows[0].draft_violations as { rule: string }[]).map((v) => v.rule)).toEqual(expect.arrayContaining(['banned_phrase', 'subject_casing', 'unconfirmed_number', 'signoff']))
  })

  it('a check error retries, then gives up as check_failed', async () => {
    const ai = fakeAi({ checkCompany: async () => Promise.reject(new Error('perplexity HTTP 429')) })
    const m = memoryStore()
    const apify = fakeApify({ ds_apr1: [JOB_COORDINATOR] })
    await runHiringTick(NOW, null, deps(m, apify, ai))
    apify.status.apr1 = { status: 'SUCCEEDED', usageTotalUsd: 0.1 }
    await runHiringTick(LATER, null, deps(m, apify, ai))
    expect(m.rows[0]).toMatchObject({ stage: 'pending', attempts: 1 })
    await runHiringTick(LATER, null, deps(m, apify, ai))
    await runHiringTick(LATER, null, deps(m, apify, ai))
    expect(m.rows[0]).toMatchObject({ stage: 'done', skip_reason: 'check_failed', attempts: 3 })
  })
})

describe('schedule off', () => {
  it('a plain tick never starts a run; only the manual override does', async () => {
    const m = memoryStore({ dry_run: true, schedule: false, lanes: { hiring: true } })
    const apify = fakeApify()
    const ai = fakeAi()
    const r = await runHiringTick(NOW, null, deps(m, apify, ai))
    expect(r.started).toEqual([])
    expect(apify.startRun).not.toHaveBeenCalled()
    const r2 = await runHiringTick(NOW, { lane: 'hiring', run_cap_usd: 0.5, max_items: 25, force: true } as never, deps(m, apify, ai))
    expect(r2.started).toHaveLength(1)
    expect(apify.startRun).toHaveBeenCalledTimes(1)
  })
})
