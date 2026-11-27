// Run: deno test _shared/signal/icp_test.ts
// The ICP gate: owner-operators only, 500+ doors, unknown count held (signal_config.icp).
import { assertEquals } from 'jsr:@std/assert@1'
import { type Counts, type FilterDeps, runCommenterStages, runReactorStages, stageVerify } from './filter.ts'
import { DEFAULT_ICP, type Icp, readIcp, unitGate } from './icp.ts'
import { runTick, type TickDeps } from './tick.ts'
import { FACTS, FakeApify, Fakes, FakeStore, gateFor, person } from './testkit.ts'

function setup(rows: Parameters<typeof person>[0][], icp?: Icp) {
  const s = new FakeStore()
  rows.forEach((r, i) => s.people.push(person({ id: i + 1, linkedin_url: `https://www.linkedin.com/in/p${i + 1}`, ...r })))
  const f = new Fakes()
  f.verify.is_pm_company = false
  f.verify.is_owner_operator = true
  const deps = (): FilterDeps => ({
    store: s, gate: gateFor(s), now: () => new Date(s.clock()), timeLeft: () => 110_000,
    haiku: f.haiku, perplexity: f.perplexity, crawl: f.crawl, email: f.email, facts: FACTS, reactorOpening: null, icp,
  })
  return { s, f, deps }
}

Deno.test('readIcp: defaults 500 / owner-operator only / hold; malformed values fall back', () => {
  assertEquals(readIcp(undefined), DEFAULT_ICP)
  assertEquals(readIcp({ min_units: 'x', owner_operator_only: 'yes', unknown_units: 'maybe' }), DEFAULT_ICP)
  assertEquals(readIcp({ min_units: 250, owner_operator_only: false, unknown_units: 'skip' }), { min_units: 250, owner_operator_only: false, unknown_units: 'skip' })
  assertEquals([unitGate(500, DEFAULT_ICP), unitGate(499, DEFAULT_ICP), unitGate(null, DEFAULT_ICP)], ['continue', 'skip', 'hold'])
})

Deno.test('a property-management company is skipped at verify, before any crawl spend', async () => {
  const { s, f, deps } = setup([{ stage: 'verify' }])
  f.verify.is_pm_company = true
  f.verify.is_owner_operator = false
  const c: Counts = {}
  await runCommenterStages(deps(), c)
  assertEquals([s.get(1).stage, s.get(1).skip_reason, s.get(1).segment], ['skipped', 'pm_company', 'pm'])
  assertEquals(f.calls.crawl, 0)
  assertEquals(s.spend.some((x) => x.kind === 'crawl'), false)
  assertEquals(c.skipped_pm_company, 1)
})

Deno.test('owner-operator who also manages is kept (owner wins under owner-operator-only)', async () => {
  const { s, f, deps } = setup([{ stage: 'verify' }])
  f.verify.is_pm_company = true
  f.verify.is_owner_operator = true
  await stageVerify(deps(), {})
  assertEquals([s.get(1).stage, s.get(1).segment], ['crawl', 'owner_operator'])
})

Deno.test('a PM reactor is skipped before the crawl', async () => {
  const { s, f, deps } = setup([{ stage: 'crawl', kind: 'reactor', segment: 'pm', company_website: 'https://pm.com', door_count: 900 }])
  await runReactorStages(deps(), {})
  assertEquals([s.get(1).stage, s.get(1).skip_reason], ['skipped', 'pm_company'])
  assertEquals(f.calls.crawl, 0)
})

Deno.test('500+ doors continue to ready (Slack card path)', async () => {
  const { s, f, deps } = setup([{ stage: 'triage' }])
  f.doorsHint = '500 units'
  await runCommenterStages(deps(), {})
  assertEquals([s.get(1).stage, s.get(1).door_count, s.get(1).segment], ['ready', 500, 'owner_operator'])
})

Deno.test('known and under 500 is skipped: at verify when the count is already known (no crawl spend)', async () => {
  const { s, f, deps } = setup([{ stage: 'verify' }])
  f.verify.door_count = 120
  await runCommenterStages(deps(), {})
  assertEquals([s.get(1).stage, s.get(1).skip_reason], ['skipped', 'under_min_units'])
  assertEquals(f.calls.crawl, 0)
})

Deno.test('known and under 500 is skipped: after the crawl hint gives the count', async () => {
  const { s, f, deps } = setup([{ stage: 'triage' }])
  f.doorsHint = '320 units'
  await runCommenterStages(deps(), {})
  assertEquals([s.get(1).stage, s.get(1).skip_reason, s.get(1).door_count], ['skipped', 'under_min_units', 320])
})

Deno.test('unknown count is held: no ready, no card, kept with skip_reason null', async () => {
  const { s, f, deps } = setup([{ stage: 'triage' }])
  f.doorsHint = null // crawl gives no count; the doors question finds none either
  const c: Counts = {}
  await runCommenterStages(deps(), c)
  assertEquals([s.get(1).stage, s.get(1).skip_reason, s.get(1).door_count], ['held', null, null])
  assertEquals(c.held_units_unknown, 1)
  // A second tick leaves it where it is (nothing reads 'held' but the owner's typed count).
  await runCommenterStages(deps(), c)
  assertEquals(s.get(1).stage, 'held')
  // A reactor with no count is held too.
  const r = setup([{ stage: 'crawl', kind: 'reactor', segment: 'owner_operator', company_website: 'https://oo.com' }])
  await runReactorStages(r.deps(), {})
  assertEquals(r.s.get(1).stage, 'held')
})

Deno.test('release by typed count: held → contacts with 500+ reaches ready; under 500 skips', async () => {
  // Lume's release writes exactly this (lume/lib/signals/held.ts): door_count + stage 'contacts', or skipped.
  const { s, deps } = setup([
    { stage: 'held', segment: 'owner_operator', crawl_verdict: 'owner_operator', company_website: 'https://oo.com' },
  ])
  await s.patchPerson(1, { door_count: 750, door_count_source: 'owner', door_count_confidence: 'high', stage: 'contacts' }, 'held')
  await runCommenterStages(deps(), {})
  assertEquals([s.get(1).stage, s.get(1).door_count], ['ready', 750])
  assertEquals(unitGate(300, DEFAULT_ICP), 'skip')
})

Deno.test('settings respected: lower minimum, PMs allowed, unknown continues', async () => {
  const icp: Icp = { min_units: 100, owner_operator_only: false, unknown_units: 'continue' }
  const a = setup([{ stage: 'triage' }], icp)
  a.f.verify.is_pm_company = true
  a.f.verify.is_owner_operator = false
  a.f.doorsHint = '150 units'
  await runCommenterStages(a.deps(), {})
  assertEquals([a.s.get(1).stage, a.s.get(1).segment], ['ready', 'pm'])
  const b = setup([{ stage: 'triage' }], icp)
  await runCommenterStages(b.deps(), {})
  assertEquals([b.s.get(1).stage, b.s.get(1).door_count], ['ready', null])
  const sk = setup([{ stage: 'triage' }], { ...DEFAULT_ICP, unknown_units: 'skip' })
  await runCommenterStages(sk.deps(), {})
  assertEquals([sk.s.get(1).stage, sk.s.get(1).skip_reason], ['skipped', 'units_unknown'])
})

Deno.test('the tick reads signal_config.icp from lume_settings', async () => {
  const s = new FakeStore()
  s.config = { ...(s.config as Record<string, unknown>), icp: { min_units: 10000 } }
  s.people.push(person({ id: 1, stage: 'contacts', kind: 'commenter', segment: 'owner_operator' }))
  s.people.push(person({ id: 2, linkedin_url: 'https://www.linkedin.com/in/p2', stage: 'doors', segment: 'owner_operator', door_count: 5000, crawl_verdict: 'owner_operator' }))
  const f = new Fakes()
  let t = Date.parse('2026-11-23T20:00:00Z')
  const deps: TickDeps = {
    store: s, apify: new FakeApify(), rest: () => Promise.reject(new Error('unused')),
    ingestReactorRuns: () => Promise.resolve({ ingested: 0 }),
    haiku: f.haiku, perplexity: f.perplexity, crawl: f.crawl, email: f.email, facts: FACTS,
    clock: () => (t += 10), uuid: () => 'tok',
  }
  await runTick(deps)
  assertEquals([s.get(2).stage, s.get(2).skip_reason], ['skipped', 'under_min_units'])
})
