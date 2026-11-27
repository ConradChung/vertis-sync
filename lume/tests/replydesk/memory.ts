import { parseReplyDeskConfig } from '@/lib/replydesk/config'
import type { AiCall, AiPort, AiResult, DealRef, Deps, DraftRow, InboundRow, SlackPort, Store, ThreadRow } from '@/lib/replydesk/engine'
import { FALLBACK_FACTS } from '@/lib/replydesk/macros'

/** In-memory ports for the reply desk engine. `log` records the order of every write and call. */

export const TEAM = 'T082MHH6U5P'
export const CHANNEL = 'C0SENDPLT'
export const BOT = 'U0LUMEBOT'

export interface MemDeal extends DealRef {
  linkedin_url: string | null
  email: string | null
  campaign_id: string
}

export class MemStore implements Store {
  log: string[] = []
  config: Record<string, unknown> = { slack: { team_id: TEAM, channel_id: CHANNEL, channel_name: 'sendpilot' }, monthly_cap_usd: 10 }
  spend: { kind: string; usd: number }[] = []
  inbound: (InboundRow & { raw: unknown; status: string; extraction: unknown; error: string | null })[] = []
  deals: MemDeal[] = []
  stages: { deal: string; stage: string; source: string; reason: string | null }[] = []
  activities: { deal: string; kind: string; source: string; key: string; payload: Record<string, unknown> }[] = []
  threads = new Map<string, ThreadRow>()
  drafts: (DraftRow & { decided_at?: string; decided_by?: string | null; model: string | null; usd: number; reason: string | null })[] = []
  signals: { url: string; name: string; company: string; email: string | null }[] = []

  async getConfig() {
    return parseReplyDeskConfig(this.config)
  }
  async monthSpend() {
    return this.spend.reduce((s, r) => s + r.usd, 0)
  }
  async addSpend(row: { kind: string; usd: number }) {
    this.log.push(`spend:${row.kind}`)
    this.spend.push(row)
  }
  async saveInbound(row: { team_id: string; channel_id: string; ts: string; raw: unknown }) {
    this.log.push('saveInbound')
    if (this.inbound.some((r) => r.channel_id === row.channel_id && r.ts === row.ts)) return null
    const id = this.inbound.length + 1
    this.inbound.push({ id, ...row, received_at: '2026-11-25T18:00:00.000Z', label: null, person_name: null, company: null, linkedin_url: null, message: null, check_back_on: null, deal_id: null, status: 'saved', extraction: null, error: null })
    return id
  }
  async updateInbound(id: number, patch: Record<string, unknown>) {
    Object.assign(this.inbound.find((r) => r.id === id)!, patch)
  }
  async getInbound(id: number) {
    return this.inbound.find((r) => r.id === id) ?? null
  }
  async matchPerson(url: string | null) {
    if (!url) return { deal: null, signal: null }
    const s = this.signals.find((x) => x.url === url)
    const signal = s ? { name: s.name, company: s.company, email: s.email } : null
    const deal = this.deals.find((d) => d.linkedin_url === url) ?? (s?.email ? this.deals.find((d) => d.email === s.email) : undefined) ?? null
    return { deal, signal }
  }
  async createDeal(row: { linkedin_url: string | null; email: string | null; name: string | null; company: string | null }) {
    this.log.push('createDeal')
    const d: MemDeal = { id: `deal-${this.deals.length + 1}`, stage: 'Contacted', campaign_id: 'linkedin', ...row }
    this.deals.push(d)
    return { ...d }
  }
  async updateDeal(id: string, patch: Record<string, unknown>) {
    Object.assign(this.deals.find((d) => d.id === id)!, patch)
  }
  async setStage(dealId: string, stage: string, source: string, reason?: string | null) {
    const d = this.deals.find((x) => x.id === dealId)
    if (!d) return null
    const from = d.stage
    d.stage = stage
    this.stages.push({ deal: dealId, stage, source, reason: reason ?? null })
    return from
  }
  async addActivity(deal: string, kind: string, payload: Record<string, unknown>, source: string, key: string) {
    if (this.activities.some((a) => a.key === key)) return
    this.activities.push({ deal, kind, source, key, payload })
  }
  async getThread(dealId: string) {
    const t = this.threads.get(dealId)
    return t ? { ...t } : null
  }
  async upsertThread(row: ThreadRow) {
    this.threads.set(row.deal_id, { ...row })
  }
  async patchThread(dealId: string, patch: Partial<ThreadRow>, ifDueAt?: string) {
    const t = this.threads.get(dealId)
    if (!t || (ifDueAt !== undefined && t.next_due_at !== ifDueAt)) return false
    Object.assign(t, patch)
    return true
  }
  async dueThreads(now: string, limit: number) {
    return [...this.threads.values()].filter((t) => t.schedule && t.next_due_at && t.next_due_at <= now).slice(0, limit).map((t) => ({ ...t }))
  }
  async insertDraft(row: Omit<DraftRow, 'id' | 'created_at'> & { model: string | null; usd: number; reason: string | null }) {
    this.log.push(`draft:${row.kind}`)
    const d = { ...row, id: this.drafts.length + 1, created_at: '2026-11-25T18:00:00.000Z' }
    this.drafts.push(d)
    return { ...d }
  }
  async patchDraft(id: number, patch: Partial<DraftRow>, from?: DraftRow['status']) {
    const d = this.drafts.find((x) => x.id === id)
    if (!d || (from && d.status !== from)) return false
    Object.assign(d, patch)
    return true
  }
  async getDraft(id: number) {
    const d = this.drafts.find((x) => x.id === id)
    return d ? { ...d } : null
  }
  async dealDrafts(dealId: string) {
    return this.drafts.filter((d) => d.deal_id === dealId).map((d) => ({ ...d }))
  }
  async facts() {
    return [...FALLBACK_FACTS]
  }
}

/** Claude fake: extraction and draft answers are queued per kind; the last one repeats. */
export class FakeAi implements AiPort {
  calls: AiCall[] = []
  extract: unknown[] = []
  draft: unknown[] = [{ macro: 'pricing', body: 'It is $9.50 per door per month after a free week on the doors you pick, month to month. Which doors would you start with?' }]
  usd = 0.01
  fail = false
  constructor(private store?: MemStore) {}
  async call(c: AiCall): Promise<AiResult> {
    this.store?.log.push(`claude:${c.kind}`)
    this.calls.push(c)
    if (this.fail) throw new Error('overloaded')
    const q = c.kind === 'extract' ? this.extract : this.draft
    const next = q.length > 1 ? q.shift() : q[0]
    return { model: c.model, text: next === undefined ? null : typeof next === 'string' ? next : JSON.stringify(next), stop: 'end_turn', usd: this.usd, input_tokens: 100, output_tokens: 50 }
  }
}

export class FakeSlack implements SlackPort {
  posts: { team: string; channel: string; thread_ts: string; msg: { text: string; blocks: unknown[] } }[] = []
  updates: { ts: string; msg: { text: string; blocks: unknown[] } }[] = []
  constructor(private store?: MemStore) {}
  async botUserId() {
    return BOT
  }
  async postThread(team: string, channel: string, thread_ts: string, msg: { text: string; blocks: unknown[] }) {
    this.store?.log.push('slack:post')
    this.posts.push({ team, channel, thread_ts, msg })
    return { ts: `1764100000.00${this.posts.length}` }
  }
  async update(_team: string, _channel: string, ts: string, msg: { text: string; blocks: unknown[] }) {
    this.updates.push({ ts, msg })
  }
}

export function memDeps(at = '2026-11-25T18:00:00.000Z') {
  const store = new MemStore()
  const ai = new FakeAi(store)
  const slack = new FakeSlack(store)
  const clock = { now: new Date(at) }
  const deps: Deps = { store, ai, slack, now: () => clock.now }
  return { store, ai, slack, clock, deps }
}

/** A realistic SendPilot notification (a bot post with an attachment). The real format has not been seen yet. */
export function sendpilotEvent(o: { ts?: string; channel?: string; user?: string | null; message?: string; name?: string; url?: string; thread_ts?: string } = {}) {
  const name = o.name ?? 'Dana Whitfield'
  const url = o.url ?? 'https://www.linkedin.com/in/dana-whitfield-12ab'
  return {
    team: TEAM,
    channel: o.channel ?? CHANNEL,
    ts: o.ts ?? '1764093600.000100',
    thread_ts: o.thread_ts ?? null,
    user: o.user === undefined ? null : o.user,
    raw: {
      text: `New reply from ${name} in campaign "Owner-operators 500+ Q4"`,
      blocks: [],
      attachments: [
        {
          color: '#4A90E2',
          title: `${name} replied`,
          title_link: url,
          text: o.message ?? 'Interesting. What does it cost?',
          fields: [
            { title: 'Company', value: 'Whitfield Holdings', short: true },
            { title: 'Campaign', value: 'Owner-operators 500+ Q4', short: true },
            { title: 'Profile', value: `<${url}|View on LinkedIn>`, short: false },
          ],
        },
      ],
      user: null,
      bot_id: 'B0SENDPLT',
      app_id: 'A0SENDPLT',
      username: 'SendPilot',
      subtype: 'bot_message',
    },
  }
}

export const extraction = (o: Record<string, unknown> = {}) => ({
  person_name: 'Dana Whitfield',
  company: 'Whitfield Holdings',
  linkedin_url: 'https://www.linkedin.com/in/dana-whitfield-12ab',
  message: 'Interesting. What does it cost?',
  campaign: 'Owner-operators 500+ Q4',
  label: 'question',
  check_back_on: null,
  ...o,
})
