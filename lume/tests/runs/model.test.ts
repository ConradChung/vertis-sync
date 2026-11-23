import { describe, expect, it } from 'vitest'
import {
  checkedOfTotal,
  classifyReactor,
  COMMENTS_LANE_REASON,
  digestCounts,
  dropReason,
  duration,
  groupReactors,
  isRunKind,
  lookupProgress,
  parseRunId,
  runHeadline,
  runHref,
  spendVsCap,
  statusTone,
  TRIAGE_NO_REASON,
  type ReactorRow,
} from '@/lib/runs/model'

const RUN = '11111111-2222-3333-4444-555555555555'
const OLD = '99999999-2222-3333-4444-555555555555'

let seq = 0
const reactor = (o: Partial<ReactorRow> = {}): ReactorRow => ({
  id: ++seq,
  name: `P${seq}`,
  headline: null,
  linkedin_url: `https://www.linkedin.com/in/p${seq}`,
  triage: null,
  verdict: null,
  verify_reason: null,
  skip_reason: null,
  company_name: null,
  company_website: null,
  door_count: null,
  exported_at: null,
  first_seen_run: RUN,
  last_seen_run: RUN,
  ...o,
})

describe('run kinds and ids', () => {
  it('knows every progress kind and nothing else', () => {
    for (const k of ['validation', 'apify', 'influencer_run', 'influencer_lookup', 'leadsfriday_order', 'job_batch', 'company_check']) expect(isRunKind(k)).toBe(true)
    expect(isRunKind('actions')).toBe(false)
    expect(isRunKind('')).toBe(false)
  })

  it('uuid ids for table rows, Apify ids for Apify; anything else is null (404)', () => {
    expect(parseRunId('influencer_run', RUN.toUpperCase())).toBe(RUN)
    expect(parseRunId('company_check', 'not-a-uuid')).toBeNull()
    expect(parseRunId('company_check', undefined)).toBeNull()
    expect(parseRunId('apify', 'HG7ML7M8z78YcAPEB')).toBe('HG7ML7M8z78YcAPEB')
    expect(parseRunId('apify', '../etc')).toBeNull()
    expect(parseRunId('apify', 'a'.repeat(65))).toBeNull()
  })

  it('runHref builds /runs/<kind>/<id>', () => {
    expect(runHref('company_check', RUN)).toBe(`/runs/company_check/${RUN}`)
    expect(runHref('apify', 'a b')).toBe('/runs/apify/a%20b')
  })
})

describe('dropReason', () => {
  it('maps the comments lane, a verify rejection and a headline "no"', () => {
    expect(dropReason({ skip_reason: 'already_in_signal', verdict: null, verify_reason: null, triage: 'likely' })).toBe(COMMENTS_LANE_REASON)
    expect(dropReason({ skip_reason: null, verdict: 'rejected', verify_reason: 'Works at a REIT, not a PM firm', triage: 'likely' })).toBe('Works at a REIT, not a PM firm')
    expect(dropReason({ skip_reason: null, verdict: 'rejected', verify_reason: '  ', triage: 'possible' })).toMatch(/rejected at verify/)
    expect(dropReason({ skip_reason: null, verdict: null, verify_reason: null, triage: 'no' })).toBe(TRIAGE_NO_REASON)
    expect(TRIAGE_NO_REASON).toBe('headline: not a PM decision-maker')
    expect(COMMENTS_LANE_REASON).toBe('already in the comments lane (GTM-14)')
  })

  it('verified, pending and verify errors are not drops; the comments lane wins over everything', () => {
    expect(dropReason({ skip_reason: null, verdict: 'verified', verify_reason: null, triage: 'likely' })).toBeNull()
    expect(dropReason({ skip_reason: null, verdict: null, verify_reason: null, triage: 'likely' })).toBeNull()
    expect(dropReason({ skip_reason: null, verdict: 'error', verify_reason: null, triage: 'possible' })).toBeNull()
    expect(dropReason({ skip_reason: 'already_in_signal', verdict: 'verified', verify_reason: null, triage: 'likely' })).toBe(COMMENTS_LANE_REASON)
  })
})

describe('groupReactors', () => {
  it('passed (most doors first) / dropped with reasons / known or skipped, new vs known, exported count', () => {
    const rows = [
      reactor({ verdict: 'verified', triage: 'likely', door_count: 300, exported_at: '2026-11-20T00:00:00Z' }),
      reactor({ verdict: 'verified', triage: 'likely', door_count: 1200, first_seen_run: OLD }),
      reactor({ triage: 'no' }),
      reactor({ triage: 'no' }),
      reactor({ triage: 'likely', verdict: 'rejected', verify_reason: 'vendor' }),
      reactor({ skip_reason: 'already_in_signal' }),
      reactor({ first_seen_run: OLD }),
      reactor({ triage: 'possible', verdict: 'error' }),
      reactor({ triage: 'likely' }),
      reactor({}),
    ]
    const g = groupReactors(rows, RUN)
    expect(g.passed.map((p) => p.door_count)).toEqual([1200, 300])
    expect(g.passed[0].seen).toBe('known')
    expect(g.passed[1].seen).toBe('new')
    expect(g.dropped).toHaveLength(4)
    expect(g.dropReasons).toEqual([
      { reason: TRIAGE_NO_REASON, count: 2 },
      expect.objectContaining({ count: 1 }),
      expect.objectContaining({ count: 1 }),
    ])
    expect(g.dropReasons.map((r) => r.reason)).toEqual(expect.arrayContaining(['rejected at verify', COMMENTS_LANE_REASON]))
    expect(g.known.map((k) => k.reason)).toEqual(['known from an earlier run', 'verify failed (retried next run)', 'awaiting verify', 'not triaged yet'])
    expect(g.exported).toBe(1)
  })

  it('classifyReactor keeps the rejection text as the reason', () => {
    expect(classifyReactor(reactor({ verdict: 'rejected', verify_reason: 'Not a decision maker' }), RUN)).toMatchObject({ group: 'dropped', reason: 'Not a decision maker', seen: 'new' })
  })
})

describe('spendVsCap', () => {
  it('"$X of $Y" and the fill percent', () => {
    expect(spendVsCap('1.2', '24.01')).toEqual({ spent: 1.2, cap: 24.01, pct: 5, over: false, label: '$1.20 of $24.01' })
    expect(spendVsCap(5, 10).pct).toBe(50)
  })

  it('caps the bar at 100% and flags over-spend', () => {
    expect(spendVsCap(12, 10)).toMatchObject({ pct: 100, over: true, label: '$12.00 of $10.00' })
  })

  it('no cap or a zero cap: spend alone, no bar; junk spend reads as 0', () => {
    expect(spendVsCap(3, null)).toEqual({ spent: 3, cap: null, pct: null, over: false, label: '$3.00 spent (no cap)' })
    expect(spendVsCap(3, 0).pct).toBeNull()
    expect(spendVsCap('x', 4)).toMatchObject({ spent: 0, pct: 0, label: '$0.00 of $4.00' })
  })
})

describe('small mappers', () => {
  it('checkedOfTotal: settled of all items, falling back to companies_total', () => {
    expect(checkedOfTotal({ pending: 30, done: 60, cached: 10 }, 999)).toEqual({ checked: 70, total: 100 })
    expect(checkedOfTotal({}, 40)).toEqual({ checked: 40, total: 40 })
  })

  it('lookupProgress: looked up of all candidates', () => {
    expect(lookupProgress({ pending_lookup: 4, found: 5, not_found: 1 })).toEqual({ done: 6, total: 10 })
  })

  it('digestCounts tallies GTM-14 cards by status', () => {
    expect(digestCounts([{ digest_status: 'posted' }, { digest_status: 'posted' }, { digest_status: 'empty' }, { digest_status: null }])).toEqual({ posted: 2, empty: 1, none: 1 })
  })

  it('runHeadline keeps present numeric counts in pipeline order', () => {
    expect(runHeadline({ unique_reactors: 80, reactions: '120', posts: 12, top_posts: null, junk: 3 })).toEqual([
      { label: 'posts scraped', value: 12 },
      { label: 'reactions', value: 120 },
      { label: 'unique reactors', value: 80 },
    ])
    expect(runHeadline(null)).toEqual([])
  })

  it('statusTone across kinds (Apify upper case too)', () => {
    expect(statusTone('SUCCEEDED')).toBe('ok')
    expect(statusTone('awaiting_approval')).toBe('live')
    expect(statusTone('capped')).toBe('bad')
    expect(statusTone(null)).toBe('idle')
  })

  it('duration', () => {
    expect(duration('2026-11-01T00:00:00Z', '2026-11-01T00:03:12Z')).toBe('3m 12s')
    expect(duration('2026-11-01T00:00:00Z', '2026-11-01T01:04:00Z')).toBe('1h 4m')
    expect(duration(null, '2026-11-01T00:00:00Z')).toBeNull()
  })
})
