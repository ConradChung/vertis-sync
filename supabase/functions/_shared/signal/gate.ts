// GTM-14: the spend gate. Every paid call in the comments lane goes through
// it: caps are checked first (caps.ts), a refused spend stops the lane and
// files one notice, settled spend is written to signal_spend and checked
// against the 80% warning.
import { type Caps, checkCap, type Cycle, type Lane, ptDayStart, stopActive, stoppedReason, warnings } from './caps.ts'
import type { SignalState, Store } from './store.ts'

export interface GateInit {
  caps: Caps
  /** null when Apify usage couldn't be read: nothing is spent this tick. */
  cycle: Cycle | null
  accountUsageUsd: number | null
  accountCapUsd: number | null
  state: SignalState
  now: () => Date
}

const r4 = (n: number) => Math.round(n * 10_000) / 10_000

export class Gate {
  stopped: boolean
  reason: string | null = null
  notices: string[] = []
  reservedUsd = 0
  settledUsd = 0

  constructor(private store: Store, private g: GateInit) {
    this.stopped = !!g.state.stopped_at && stopActive(g.state, g.now(), g.cycle)
    if (this.stopped) this.reason = g.state.stopped_reason
    if (!g.cycle) this.reason = this.reason ?? 'apify_usage_unavailable'
  }

  get cycle() {
    return this.g.cycle
  }

  /** Clears a recorded stop whose window has passed (call once at tick start). */
  async clearExpiredStop(): Promise<boolean> {
    const s = this.g.state
    if (!s.stopped_at || this.stopped) return false
    await this.store.patchState({ stopped_at: null, stopped_reason: null })
    return true
  }

  get canSpend(): boolean {
    return !this.stopped && !!this.g.cycle
  }

  /** May `usd` be spent on `lane` now? A refusal that crosses a cap stops the lane (state + one notice). */
  async allow(lane: Lane, usd: number): Promise<boolean> {
    if (!this.canSpend) return false
    const cycle = this.g.cycle!
    const now = this.g.now()
    const [apifyCycle, filterCycle, daily] = await Promise.all([
      this.store.laneSpend(['comments_apify'], cycle.startAt),
      this.store.laneSpend(['comments_filter'], cycle.startAt),
      this.store.laneSpend(['comments_apify', 'comments_filter'], ptDayStart(now).toISOString()),
    ])
    let account
    if (lane === 'comments_apify' && this.g.accountUsageUsd !== null && this.g.accountCapUsd !== null) {
      account = { usageUsd: this.g.accountUsageUsd, openReservedUsd: await this.store.openApifyReservedUsd(), capUsd: this.g.accountCapUsd }
    }
    const c = checkCap({ lane, usd, caps: this.g.caps, cycle, now, spent: { apifyCycle, filterCycle, daily }, account })
    if (c.ok) return true
    this.stopped = true
    this.reason = stoppedReason(c)
    await this.store.patchState({ stopped_at: now.toISOString(), stopped_reason: stoppedReason(c) })
    if (await this.store.insertNotice(c.noticeKey, c.text)) this.notices.push(c.noticeKey)
    return false
  }

  /** A settled filter-lane spend (already paid). */
  async record(kind: string, usd: number, ref: { person_id?: number | null; post_id?: string | null } = {}): Promise<void> {
    const v = r4(Math.max(0, usd))
    await this.store.insertSpend({ lane: 'comments_filter', kind, status: 'settled', usd: v, person_id: ref.person_id ?? null, post_id: ref.post_id ?? null })
    this.settledUsd = r4(this.settledUsd + v)
    await this.warn()
  }

  /** Checks the caps and writes the reservation row; null when refused. */
  async reserve(kind: string, usd: number, postId: string | null): Promise<number | null> {
    if (!(await this.allow('comments_apify', usd))) return null
    const id = await this.store.insertSpend({ lane: 'comments_apify', kind, status: 'reserved', usd, post_id: postId })
    this.reservedUsd = r4(this.reservedUsd + usd)
    return id
  }

  async settle(id: number, usd: number): Promise<boolean> {
    const ok = await this.store.patchSpend(id, { status: 'settled', usd: r4(usd), settled_at: this.g.now().toISOString() }, true)
    if (ok) {
      this.settledUsd = r4(this.settledUsd + usd)
      await this.warn()
    }
    return ok
  }

  async release(id: number): Promise<boolean> {
    return await this.store.patchSpend(id, { status: 'released', settled_at: this.g.now().toISOString() }, true)
  }

  private warned = new Set<string>()
  async warn(): Promise<void> {
    const cycle = this.g.cycle
    if (!cycle) return
    const [apifyCycle, filterCycle] = await Promise.all([
      this.store.laneSpend(['comments_apify'], cycle.startAt),
      this.store.laneSpend(['comments_filter'], cycle.startAt),
    ])
    for (const w of warnings(this.g.caps, cycle, { apifyCycle, filterCycle })) {
      if (this.warned.has(w.key)) continue
      this.warned.add(w.key)
      if (await this.store.insertNotice(w.key, w.text)) this.notices.push(w.key)
    }
  }
}
