// Run: deno test _shared/signal/caps_test.ts
import { assert, assertEquals } from 'jsr:@std/assert@1'
import { checkCap, DEFAULT_CAPS, parseUsageCycle, ptDate, ptDayStart, ptNextDayStart, stopActive } from './caps.ts'
import { CYCLE, FakeStore, gateFor } from './testkit.ts'

const NOW = new Date('2026-11-23T20:00:00Z') // 12:00 PT
const base = { caps: DEFAULT_CAPS, cycle: CYCLE, now: NOW }

Deno.test('PT day boundaries (PST and across DST)', () => {
  assertEquals(ptDate(new Date('2026-11-24T07:59:00Z')), '2026-11-23')
  assertEquals(ptDayStart(NOW).toISOString(), '2026-11-23T08:00:00.000Z')
  assertEquals(ptNextDayStart(NOW).toISOString(), '2026-11-24T08:00:00.000Z')
  assertEquals(ptDayStart(new Date('2026-07-01T12:00:00Z')).toISOString(), '2026-07-01T07:00:00.000Z')
  assertEquals(ptNextDayStart(new Date('2026-11-01T12:00:00Z')).toISOString(), '2026-11-02T08:00:00.000Z') // DST ends Nov 1
})

Deno.test('usage/monthly: cycle and account usage, never hardcoded', () => {
  const u = parseUsageCycle({ data: { usageCycle: { startAt: '2026-11-04T00:00:00.000Z', endAt: '2026-12-03T23:59:59.999Z' }, totalUsageCreditsUsdAfterVolumeDiscount: 12.5 } })
  assertEquals(u, { cycle: { startAt: '2026-11-04T00:00:00.000Z', endAt: '2026-12-03T23:59:59.999Z' }, usageUsd: 12.5 })
  assertEquals(parseUsageCycle({ data: {} }), null)
})

Deno.test('caps: daily stop across both lanes', () => {
  const c = checkCap({ ...base, lane: 'comments_filter', usd: 0.05, spent: { apifyCycle: 0.6, filterCycle: 0.4, daily: 0.99 } })
  assert(!c.ok)
  if (!c.ok) {
    assertEquals([c.cap, c.window, c.noticeKey], ['daily', 'daily:2026-11-23', 'stop:daily:2026-11-23'])
    assertEquals(c.resetsAt, '2026-11-24T08:00:00.000Z')
    assert(c.text.includes('$1.00') && c.text.includes('Nov 24'))
  }
  assertEquals(checkCap({ ...base, lane: 'comments_filter', usd: 0.01, spent: { apifyCycle: 0, filterCycle: 0, daily: 0.99 } }).ok, true)
})

Deno.test('caps: cycle stop per lane', () => {
  const a = checkCap({ ...base, lane: 'comments_apify', usd: 0.21, spent: { apifyCycle: 9.9, filterCycle: 0, daily: 0 }, account: { usageUsd: 1, openReservedUsd: 0, capUsd: 29 } })
  assert(!a.ok && a.window === 'comments_apify:2026-11-04' && a.resetsAt === CYCLE.endAt)
  const f = checkCap({ ...base, lane: 'comments_filter', usd: 0.012, spent: { apifyCycle: 0, filterCycle: 4.995, daily: 0 } })
  assert(!f.ok && f.window === 'comments_filter:2026-11-04')
})

Deno.test('caps: account guard counts usage + open reservations + this one', () => {
  const spent = { apifyCycle: 1, filterCycle: 0, daily: 0 }
  const over = checkCap({ ...base, lane: 'comments_apify', usd: 0.21, spent, account: { usageUsd: 28.5, openReservedUsd: 0.4, capUsd: 29 } })
  assert(!over.ok && over.cap === 'account' && over.noticeKey === 'stop:account:2026-11-04')
  assertEquals(checkCap({ ...base, lane: 'comments_apify', usd: 0.21, spent, account: { usageUsd: 28, openReservedUsd: 0.4, capUsd: 29 } }).ok, true)
})

Deno.test('stopActive: lane resumes after the window', () => {
  const daily = { stopped_at: NOW.toISOString(), stopped_reason: 'daily:2026-11-23 text' }
  assertEquals(stopActive(daily, NOW, CYCLE), true)
  assertEquals(stopActive(daily, new Date('2026-11-24T08:00:01Z'), CYCLE), false)
  const cyc = { stopped_at: NOW.toISOString(), stopped_reason: 'comments_apify:2026-11-04 text' }
  assertEquals(stopActive(cyc, NOW, CYCLE), true)
  assertEquals(stopActive(cyc, new Date('2026-12-05T00:00:00Z'), { startAt: '2026-12-04T00:00:00.000Z', endAt: '2027-01-04T00:00:00.000Z' }), false)
  assertEquals(stopActive(cyc, NOW, null), true)
})

Deno.test('gate: a refused spend stops the lane, files one notice, nothing is spent after', async () => {
  const s = new FakeStore()
  await s.insertSpend({ lane: 'comments_filter', kind: 'perplexity', status: 'settled', usd: 0.995 })
  const g = gateFor(s)
  assertEquals(await g.allow('comments_filter', 0.012), false)
  assertEquals(s.state_.stopped_reason?.startsWith('daily:2026-11-23 '), true)
  assertEquals([...s.notices.keys()], ['stop:daily:2026-11-23'])
  assertEquals(await g.allow('comments_filter', 0.0001), false) // stopped for the rest of the tick
  // The next tick the same day stays stopped; a new gate reads the state.
  const g2 = gateFor(s)
  assertEquals(g2.canSpend, false)
  assertEquals(await g2.clearExpiredStop(), false)
  // The next PT day: the stop clears and spending resumes.
  s.clock = () => Date.parse('2026-11-24T09:00:00Z')
  const g3 = gateFor(s)
  assertEquals(g3.canSpend, true)
  assertEquals(await g3.clearExpiredStop(), true)
  assertEquals(s.state_.stopped_at, null)
  assertEquals(await g3.allow('comments_filter', 0.012), true)
})

Deno.test('gate: account guard refuses an Apify reservation', async () => {
  const s = new FakeStore()
  s.apifyCap = 6
  const g = gateFor(s, { usage: 5.97 })
  assertEquals(await g.reserve('posts_48h', 0.05, null), null)
  assertEquals(s.spend.length, 0)
  assertEquals(s.notices.has('stop:account:2026-11-04'), true)
})

Deno.test('gate: 80% warning is inserted once per lane per cycle', async () => {
  const s = new FakeStore()
  await s.insertSpend({ lane: 'comments_apify', kind: 'comments', status: 'settled', usd: 7.95 })
  s.clock = () => Date.parse('2026-11-23T20:00:00Z')
  // older spend outside today so the daily cap doesn't interfere
  s.spend[0].created_at = '2026-11-10T00:00:00.000Z'
  const g = gateFor(s)
  const id = (await g.reserve('comments', 0.04, 'p1'))!
  assertEquals(s.notices.size, 0)
  await g.settle(id, 0.06) // 8.01 ≥ 8.00
  assertEquals([...s.notices.keys()], ['warn80:comments_apify:2026-11-04'])
  const id2 = (await g.reserve('comments', 0.04, 'p1'))!
  await g.settle(id2, 0.03)
  await gateFor(s).warn() // a later tick: insert is on-conflict-do-nothing
  assertEquals(s.notices.size, 1)
  assert(s.notices.get('warn80:comments_apify:2026-11-04')!.includes('$10.00'))
})
