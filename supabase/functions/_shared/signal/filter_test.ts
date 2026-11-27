// Run: deno test _shared/signal/filter_test.ts
import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@1'
import { assertReady, type Counts, type FilterDeps, runCommenterStages, runReactorStages, stageContacts, stageCrawl, stageDraft, stageTriage, stageVerify } from './filter.ts'
import { parseSignalTriage, signalVerificationQuestion } from './triage.ts'
import { Fakes, FACTS, FakeStore, gateFor, person } from './testkit.ts'

function setup(rows: Parameters<typeof person>[0][]) {
  const s = new FakeStore()
  rows.forEach((r, i) => s.people.push(person({ id: i + 1, linkedin_url: `https://www.linkedin.com/in/p${i + 1}`, ...r })))
  const f = new Fakes()
  const deps = (): FilterDeps => ({
    store: s, gate: gateFor(s), now: () => new Date(s.clock()), timeLeft: () => 110_000,
    haiku: f.haiku, perplexity: f.perplexity, crawl: f.crawl, email: f.email, facts: FACTS, reactorOpening: null,
    // These tests pin the pre-ICP stage machine; icp_test.ts covers the gate with its defaults.
    icp: { owner_operator_only: false, min_units: 0, unknown_units: 'continue' },
  })
  return { s, f, deps }
}
const paid = (s: FakeStore, kind?: string) => s.spend.filter((x) => x.lane === 'comments_filter' && (!kind || x.kind === kind))

Deno.test('triage: one Haiku call labels and pulls company_guess; no → skipped triage_no', async () => {
  const { s, f, deps } = setup([{ headline: 'Owner at Whitfield Property Management' }, { headline: '' }])
  const c: Counts = {}
  await stageTriage(deps(), c)
  assertEquals(f.calls.haiku, 1)
  assertEquals([s.get(1).stage, s.get(1).triage, s.get(1).company_guess], ['verify', 'likely', 'Whitfield Property Management'])
  assertEquals([s.get(2).stage, s.get(2).skip_reason], ['skipped', 'triage_no'])
  assertEquals(paid(s, 'haiku').map((x) => x.person_id), [1])
  const parsed = parseSignalTriage({ results: [{ id: '7', label: 'possible', company: 'null' }] }, [7, 8])
  assertEquals(parsed, { 7: { label: 'possible', company: null }, 8: { label: 'no', company: null } })
})

Deno.test('verify question carries "likely works at {company_guess}"', () => {
  assert(signalVerificationQuestion('Dana', 'Owner', 'Whitfield PM').includes('likely works at "Whitfield PM"'))
  assert(!signalVerificationQuestion('Dana', 'Owner', null).includes('likely works at'))
})

Deno.test('a vendor never reaches ready (crawl says not_property_manager)', async () => {
  const { s, f, deps } = setup([{ stage: 'triage' }])
  f.crawlVerdict = 'not_property_manager'
  const c: Counts = {}
  await runCommenterStages(deps(), c)
  assertEquals([s.get(1).stage, s.get(1).skip_reason], ['skipped', 'vendor'])
  // Even a row forced to 'draft' without a PM crawl verdict is skipped, not readied.
  s.people.push(person({ id: 2, linkedin_url: 'https://www.linkedin.com/in/x2', stage: 'draft', crawl_verdict: null }))
  await stageDraft(deps(), c, 'commenter')
  assertEquals([s.get(2).stage, s.get(2).skip_reason], ['skipped', 'vendor'])
  assertThrows(() => assertReady({ crawl_verdict: 'not_property_manager', segment: 'pm' }))
  assertEquals(s.people.some((p) => p.stage === 'ready'), false)
})

Deno.test('full commenter path → ready; crawl doors_hint sets the count and skips Perplexity doors', async () => {
  const { s, f, deps } = setup([{ stage: 'triage', commented_at: '2026-11-23T18:00:00Z' }])
  f.doorsHint = '5,000 units'
  const c: Counts = {}
  await runCommenterStages(deps(), c)
  const p = s.get(1)
  assertEquals(p.stage, 'ready')
  assertEquals([p.door_count, p.door_count_source, p.door_count_confidence, p.doors_hint], [5000, 'https://whitfieldpm.com', 'medium', '5,000 units'])
  assertEquals(f.calls.perplexity, 1) // verify only, no doors call
  // Blitz found the commenter's own work email by their LinkedIn URL (no USD charge: records, not dollars).
  assertEquals(p.contacts, [{ name: 'Dana Whitfield', title: 'Owner', linkedin_url: 'https://www.linkedin.com/in/p1', email: 'dana@whitfieldpm.com' }])
  assertEquals(f.emailUrls, ['https://www.linkedin.com/in/p1'])
  assertEquals(paid(s).some((x) => x.kind === 'email'), false)
  assertEquals((p.drafts as { opening: string }).opening, 'saw you in our thread earlier.') // no comment text → plain opening
  assertEquals(p.connected, null)
  assertEquals(paid(s, 'crawl').length, 1)
  assertEquals(paid(s, 'crawl')[0].usd, 0.0002)
  assert(paid(s).every((x) => x.person_id === 1))
})

Deno.test('no count in the hint → Perplexity doors runs; a Blitz miss ships with contacts []', async () => {
  const { s, f, deps } = setup([{ stage: 'triage' }])
  f.doorsHint = '260+ cities across 24 states plus Washington D.C. (unit count not stated)'
  f.emailResult = 'miss'
  const c: Counts = {}
  await runCommenterStages(deps(), c)
  assertEquals(f.calls.perplexity, 2)
  assertEquals(f.calls.email, 1)
  assertEquals([s.get(1).stage, s.get(1).contacts], ['ready', []])
  assertEquals(c.email_miss, 1)
  assertEquals(paid(s, 'doors').length, 1)
})

Deno.test('contacts: batch of 10 in id order; records guard at 0 → no lookup, cards still ship', async () => {
  const rows = Array.from({ length: 12 }, () => ({ stage: 'contacts' as const, crawl_verdict: 'property_manager' }))
  const { s, f, deps } = setup(rows)
  f.recordsLeft = 3
  const c: Counts = {}
  await stageContacts(deps(), c, 'commenter')
  assertEquals(f.emailUrls, ['https://www.linkedin.com/in/p1', 'https://www.linkedin.com/in/p2', 'https://www.linkedin.com/in/p3'])
  assertEquals([c.email_found, c.email_unavailable, c.contacts], [3, 7, 10])
  assertEquals(s.people.filter((p) => p.stage === 'draft').length, 10)
  assertEquals(s.get(4).contacts, [])
  assertEquals(s.get(11).stage, 'contacts') // the next batch waits for the next tick
})

Deno.test('contacts: Blitz unavailable (timeout) or no LinkedIn profile → contacts [], no retry, no throw', async () => {
  const { s, f, deps } = setup([{ stage: 'contacts' }, { stage: 'contacts', linkedin_url: 'https://www.linkedin.com/company/acme' }])
  f.emailResult = 'timeout'
  const c: Counts = {}
  await stageContacts(deps(), c, 'commenter')
  assertEquals([s.get(1).stage, s.get(1).contacts, s.get(2).stage, s.get(2).contacts], ['draft', [], 'draft', []])
  assertEquals([c.email_unavailable_timeout, c.email_no_profile, f.calls.email], [1, 1, 1])
})

Deno.test('retry at each stage does not double-charge', async () => {
  const { s, f, deps } = setup([{ stage: 'triage' }])
  await stageTriage(deps(), {})
  await stageTriage(deps(), {}) // nothing left at triage
  assertEquals(f.calls.haiku, 1)
  await stageVerify(deps(), {})
  await stageVerify(deps(), {})
  assertEquals(f.calls.perplexity, 1)
  await stageCrawl(deps(), {}, 'commenter')
  await stageCrawl(deps(), {}, 'commenter')
  assertEquals(f.calls.crawl, 1)
  const before = paid(s).length
  await runCommenterStages(deps(), {})
  await runCommenterStages(deps(), {})
  assertEquals(s.get(1).stage, 'ready')
  assertEquals(f.calls.perplexity, 2) // + one doors call, once
  assertEquals(paid(s).length, before + 2) // doors perplexity + its haiku parse
})

Deno.test('a failure bumps attempts; the second parks the row at error', async () => {
  const { s, f, deps } = setup([{ stage: 'verify' }])
  f.failPerplexity = 2
  await stageVerify(deps(), {})
  assertEquals([s.get(1).stage, s.get(1).attempts], ['verify', 1])
  await stageVerify(deps(), {})
  assertEquals(s.get(1).stage, 'error')
  assert(s.get(1).last_error?.includes('Perplexity 500'))
  assertEquals(paid(s).length, 0) // nothing paid on a failed call
})

Deno.test('crawl: unreachable retries once then skips; timed_out waits without an attempt', async () => {
  const { s, f, deps } = setup([{ stage: 'crawl', company_website: 'https://dead.example.com' }])
  f.crawlVerdict = 'unreachable'
  await stageCrawl(deps(), {}, 'commenter')
  assertEquals([s.get(1).stage, s.get(1).attempts], ['crawl', 1])
  await stageCrawl(deps(), {}, 'commenter')
  assertEquals([s.get(1).stage, s.get(1).skip_reason], ['skipped', 'unreachable'])
  const t = setup([{ stage: 'crawl', company_website: 'slow.example.com' }])
  t.f.crawlVerdict = 'timed_out'
  await stageCrawl(t.deps(), {}, 'commenter')
  await stageCrawl(t.deps(), {}, 'commenter')
  assertEquals([t.s.get(1).stage, t.s.get(1).attempts], ['crawl', 0])
})

Deno.test('reactors: crawl → doors (no paid call) → contacts → draft with the placeholder opening', async () => {
  const { s, f, deps } = setup([{ stage: 'crawl', kind: 'reactor', company_website: 'https://whitfieldpm.com', door_count: 300 }])
  await runReactorStages(deps(), {})
  const p = s.get(1)
  assertEquals(p.stage, 'ready')
  assertEquals(p.door_count, 300)
  assertEquals(f.calls.perplexity, 0)
  assertEquals((p.drafts as { opening: string; dm: string }).opening, '{opening line}.')
  assertEquals(paid(s, 'crawl').length, 1)
})

Deno.test('stopped lane: no paid stage runs', async () => {
  const { s, f, deps } = setup([{ stage: 'triage' }])
  s.state_ = { ...s.state_, stopped_at: new Date(s.clock()).toISOString(), stopped_reason: 'daily:2026-11-23 x' }
  await runCommenterStages(deps(), {})
  assertEquals(f.calls, { haiku: 0, perplexity: 0, crawl: 0, email: 0 })
  assertEquals(s.get(1).stage, 'triage')
})

Deno.test('comment reply: Haiku responds to the comment; first message has no pitch; Kaspen + demo only after they reply', async () => {
  const { s, f, deps } = setup([{ stage: 'triage', first_name: 'Dana', commented_at: '2026-11-21T18:00:00Z', comment_text: 'After-hours owner calls are the worst.' }])
  const c: Counts = {}
  await runCommenterStages(deps(), c)
  const p = s.get(1)
  assertEquals(p.stage, 'ready')
  const d = p.drafts as Record<string, string>
  assertEquals(d.source, 'comment')
  assert(d.dm.startsWith('Hey Dana, saw your comment on my post, and the point about after-hours owner calls'), d.dm)
  assert(d.dm.endsWith('How are you covering after-hours calls today?'), d.dm)
  for (const t of [d.dm, d.connection_note, d.followup_dm]) assert(!/kaspen|demo/i.test(t), t)
  assert(d.after_reply.includes('Kaspen') && d.after_reply.endsWith('Would you like to see a quick demo?'))
  assertEquals(d.followup_dm, 'Thanks for connecting, Dana! How are you covering after-hours calls today?')
  assert(!('no_note_followup' in d))
  assert(paid(s, 'haiku').length >= 3) // triage, verify parse, reply
})

Deno.test('comment reply: a bad reply retries once, then ships with the plain opening', async () => {
  const { s, f, deps } = setup([{ stage: 'draft', crawl_verdict: 'property_manager', company_name: 'Acme', comment_text: 'Great post' }])
  f.reply = null
  const c: Counts = {}
  await stageDraft(deps(), c, 'commenter')
  assertEquals([s.get(1).stage, s.get(1).attempts, c.draft_retry], ['draft', 1, 1])
  assertEquals(f.calls.haiku, 2) // two tries in the tick
  await stageDraft(deps(), c, 'commenter')
  const d = s.get(1).drafts as Record<string, string>
  assertEquals(s.get(1).stage, 'ready')
  assertEquals(d.source, 'template')
  assert(/^Hey \S+, saw your comment on my post\. I run/.test(d.dm), d.dm)
  assert(d.dm.endsWith('How is business at Acme?'))
})

Deno.test('owner-operator: kept, crawled with owner rules, labelled, readied; a vendor verdict still skips', async () => {
  const { s, f, deps } = setup([{ stage: 'triage' }])
  f.verify.is_pm_company = false
  f.verify.is_owner_operator = true
  await runCommenterStages(deps(), {})
  const p = s.get(1)
  assertEquals([p.segment, p.crawl_verdict, p.stage], ['owner_operator', 'owner_operator', 'ready'])
  assert(f.crawlRules[0]?.includes('own and operate rental real estate'))
  assertEquals(assertReady({ crawl_verdict: 'owner_operator', segment: 'owner_operator' }), 'ready')
  // A PM row can never be readied by an owner-operator verdict.
  assertThrows(() => assertReady({ crawl_verdict: 'owner_operator', segment: 'pm' }))

  const v = setup([{ stage: 'triage' }])
  v.f.verify.is_pm_company = false
  v.f.verify.is_owner_operator = true
  v.f.crawlVerdict = 'not_property_manager'
  await runCommenterStages(v.deps(), {})
  assertEquals([v.s.get(1).stage, v.s.get(1).skip_reason], ['skipped', 'vendor'])
})

Deno.test('neither PM nor owner-operator → not_pm', async () => {
  const { s, f, deps } = setup([{ stage: 'triage' }])
  f.verify.is_pm_company = false
  await runCommenterStages(deps(), {})
  assertEquals([s.get(1).stage, s.get(1).skip_reason], ['skipped', 'not_pm'])
})
