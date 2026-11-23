// Test-only: an in-memory Store (the contract migration isn't applied) and
// fakes for the tick's external calls. Imported by *_test.ts files only.
import type { ApifyClient, RunData } from './apify.ts'
import type { Cycle } from './caps.ts'
import type { Facts } from './drafts.ts'
import type { Contact, CrawlResult } from './filter.ts'
import { Gate } from './gate.ts'
import { readCaps } from './caps.ts'
import type { KnownReactor, NewPost, NewSpend, Person, PostRow, SignalState, SpendRow, Stage, Store } from './store.ts'
import { profileSlug } from './comments.ts'

export const FACTS: Facts = {
  sender_first_name: 'Frank',
  facts: ['I run a property management company of about 1,000 units in Vancouver.', "I'm a co-founder of Kaspen."],
  unconfirmed_do_not_use: ['graduating UCLA this Dec', 'a few friends from Google and Berkeley'],
  linkedin_premium: false,
  connection_note_max_chars: 200,
}

export const CYCLE: Cycle = { startAt: '2026-11-04T00:00:00.000Z', endAt: '2026-12-04T00:00:00.000Z' }

export class FakeStore implements Store {
  state_: SignalState = { last_posts_7d_at: null, last_posts_48h_at: null, first_run_at: null, stopped_at: null, stopped_reason: null }
  lease = false
  config: unknown = { dry_run: true, profile_url: 'https://www.linkedin.com/in/frank22/', caps: {}, reactor_opening: null }
  apifyCap: number | null = 29
  spend: SpendRow[] = []
  notices = new Map<string, string>()
  posts: PostRow[] = []
  people: Person[] = []
  reactors: KnownReactor[] = []
  lumeUrls: string[] = []
  lumeKeys: string[] = []
  constructor(public clock: () => number = () => Date.parse('2026-11-23T20:00:00Z')) {}

  async claimTick() {
    if (this.lease) return false
    this.lease = true
    return true
  }
  async releaseTick() {
    this.lease = false
  }
  async settings() {
    return { signalConfig: this.config, apifyCapUsd: this.apifyCap }
  }
  async state() {
    return { ...this.state_ }
  }
  async patchState(p: Partial<SignalState>) {
    Object.assign(this.state_, p)
  }
  async laneSpend(lanes: string[], since: string) {
    return this.spend.filter((s) => lanes.includes(s.lane) && s.status !== 'released' && s.created_at >= since).reduce((a, s) => a + s.usd, 0)
  }
  async openApifyReservedUsd() {
    return this.spend.filter((s) => s.status === 'reserved' && s.lane !== 'comments_filter').reduce((a, s) => a + s.usd, 0)
  }
  async insertSpend(r: NewSpend) {
    const id = this.spend.length + 1
    this.spend.push({
      id, lane: r.lane, kind: r.kind, status: r.status, usd: r.usd, apify_run_id: null, dataset_id: null,
      post_id: r.post_id ?? null, person_id: r.person_id ?? null, created_at: new Date(this.clock()).toISOString(),
    })
    return id
  }
  async patchSpend(id: number, p: Partial<SpendRow>, onlyIfReserved?: boolean) {
    const row = this.spend.find((s) => s.id === id)
    if (!row || (onlyIfReserved && row.status !== 'reserved')) return false
    const { settled_at: _s, ...rest } = p as Partial<SpendRow> & { settled_at?: string }
    Object.assign(row, rest)
    return true
  }
  async reservedApifyRuns() {
    return this.spend.filter((s) => s.lane === 'comments_apify' && s.status === 'reserved' && s.apify_run_id)
  }
  async insertNotice(key: string, text: string) {
    if (this.notices.has(key)) return false
    this.notices.set(key, text)
    return true
  }
  async upsertPosts(rows: NewPost[]) {
    for (const r of rows) {
      const p = this.posts.find((x) => x.post_id === r.post_id)
      if (p) Object.assign(p, { likes: r.likes, comment_count: r.comment_count, post_url: r.post_url, posted_at: r.posted_at })
      else this.posts.push({ ...r, comments_pulled_at_count: 0, last_comments_pull_at: null, digest_status: null })
    }
  }
  async recentPosts(since: string) {
    return this.posts.filter((p) => p.posted_at >= since).map((p) => ({ ...p }))
  }
  async patchPost(id: string, p: Partial<PostRow>) {
    Object.assign(this.posts.find((x) => x.post_id === id)!, p)
  }
  async postsDigest(ids: string[]) {
    return Object.fromEntries(this.posts.filter((p) => ids.includes(p.post_id)).map((p) => [p.post_id, p.digest_status]))
  }
  async peopleByKeys(ids: string[], urls: string[]) {
    return this.people.filter((p) => (p.linkedin_id && ids.includes(p.linkedin_id)) || urls.includes(p.linkedin_url)).map((p) => ({ ...p }))
  }
  async reactorsByKeys(ids: string[], urls: string[]) {
    return this.reactors.filter((r) => (r.linkedin_id && ids.includes(r.linkedin_id)) || urls.includes(r.linkedin_url))
  }
  async lumeLinkedinUrls(urls: string[]) {
    return this.lumeUrls.filter((u) => urls.includes(u))
  }
  async lumeLinkedinKeys(keys: string[]) {
    return this.lumeKeys.filter((k) => keys.includes(k))
  }
  async insertPerson(row: Partial<Person>) {
    if (this.people.some((p) => (row.linkedin_id && p.linkedin_id === row.linkedin_id) || p.linkedin_url === row.linkedin_url)) return 'conflict' as const
    this.people.push(person({ ...row, id: this.people.length + 1 }))
    return 'inserted' as const
  }
  async patchPerson(id: number, p: Partial<Person>, stage?: Stage) {
    const row = this.people.find((x) => x.id === id)
    if (!row || (stage && row.stage !== stage)) return false
    Object.assign(row, p)
    return true
  }
  async peopleAt(stage: Stage, kind: 'commenter' | 'reactor', limit: number) {
    return this.people.filter((p) => p.stage === stage && p.kind === kind).slice(0, limit).map((p) => ({ ...p }))
  }
  get(id: number) {
    return this.people.find((p) => p.id === id)!
  }
  bySlug(slug: string) {
    return this.people.find((p) => profileSlug(p.linkedin_url) === slug)
  }
}

export function person(p: Partial<Person>): Person {
  return {
    id: 1, linkedin_id: null, linkedin_url: 'https://www.linkedin.com/in/someone', name: 'Dana Whitfield', first_name: 'Dana',
    headline: 'Owner at Whitfield Property Management', company_guess: null, kind: 'commenter', post_id: null, comment_text: null,
    comment_url: null, commented_at: null, stage: 'triage', skip_reason: null, attempts: 0, last_error: null, triage: null,
    company_name: null, company_website: null, title: null, location: null, is_decision_maker: null, crawl_verdict: null,
    crawl_reason: null, doors_hint: null, door_count: null, door_count_source: null, door_count_confidence: null, contacts: null,
    connected: null, drafts: null, segment: 'pm', alert_status: null, spend_usd: 0, ...p,
  }
}

export function gateFor(store: FakeStore, opts: { usage?: number; cycle?: Cycle | null } = {}) {
  return new Gate(store, {
    caps: readCaps((store.config as { caps?: unknown }).caps),
    cycle: opts.cycle === undefined ? CYCLE : opts.cycle,
    accountUsageUsd: opts.usage ?? 5,
    accountCapUsd: store.apifyCap,
    state: { ...store.state_ },
    now: () => new Date(store.clock()),
  })
}

/** Counts every external call so tests can assert nothing was paid twice. */
export class Fakes {
  calls = { haiku: 0, perplexity: 0, crawl: 0, apollo: 0 }
  triageLabel: 'likely' | 'possible' | 'no' = 'likely'
  verify = { is_pm_company: true, is_owner_operator: false, is_decision_maker: true, company_website: 'https://whitfieldpm.com', door_count: null as number | null }
  /** Haiku's comment reply (drafts); null → a malformed reply. */
  reply: { response: string; question: string } | null = {
    response: 'saw your comment on my post, and the point about after-hours owner calls is spot on.',
    question: 'How are you covering after-hours calls today?',
  }
  crawlRules: (string | undefined)[] = []
  crawlVerdict: CrawlResult['verdict'] = 'property_manager'
  doorsHint: string | null = null
  failHaiku = 0
  failPerplexity = 0
  apolloStatus = 200

  haiku = async (req: { system: string; messages: { content: string }[] }) => {
    this.calls.haiku++
    if (this.failHaiku > 0) {
      this.failHaiku--
      throw new Error('Anthropic 500')
    }
    if (req.system.includes('triage LinkedIn headlines')) {
      const ids = req.messages[0].content.split('\n').map((l) => l.split('\t')[0]).filter((x) => /^\d+$/.test(x))
      return { json: { results: ids.map((id) => ({ id, label: this.triageLabel, company: 'Whitfield Property Management' })) }, usd: 0.0006 }
    }
    if (req.system.includes('two short pieces of a LinkedIn message')) {
      const opening = /starts exactly with "([^"]+)"/.exec(req.system)?.[1] ?? ''
      const r = this.reply
      return { json: r ? { ...r, response: r.response.replace(/^saw (your comment on my post|you in our thread earlier)/i, opening) } : { nope: 1 }, usd: 0.0005 }
    }
    return {
      json: {
        is_pm_company: this.verify.is_pm_company, is_owner_operator: this.verify.is_owner_operator, is_decision_maker: this.verify.is_decision_maker, title: 'Owner',
        company_name: 'Whitfield Property Management', company_website: this.verify.company_website, location: 'Austin, TX',
        city: 'Austin', state: 'TX', country: 'United States', door_count: this.verify.door_count,
        door_count_source: this.verify.door_count ? 'https://whitfieldpm.com/about' : '', door_count_confidence: this.verify.door_count ? 'high' : '',
        reason: 'r',
      },
      usd: 0.0004,
    }
  }
  perplexity = async (_q: string) => {
    this.calls.perplexity++
    if (this.failPerplexity > 0) {
      this.failPerplexity--
      throw new Error('Perplexity 500')
    }
    return { answer: 'Whitfield PM manages homes.', citations: ['https://whitfieldpm.com/about'], cost: 0.006 }
  }
  crawl = async (domains: string[], _deadline: number, rules?: string): Promise<CrawlResult[]> => {
    this.calls.crawl++
    this.crawlRules.push(rules)
    return domains.map((domain) => ({ domain, verdict: this.crawlVerdict, reason: 'r', doors_hint: this.doorsHint, confidence: 'high' }))
  }
  apollo = async (_domain: string): Promise<Contact[]> => {
    this.calls.apollo++
    if (this.apolloStatus !== 200) throw new Error(`apollo ${this.apolloStatus}`)
    return [
      { name: 'Dana Whitfield', title: 'Owner', linkedin_url: 'https://www.linkedin.com/in/dana-whitfield-3a94a6367' },
      { name: 'Sam Ortiz', title: 'COO', linkedin_url: 'https://www.linkedin.com/in/samortiz' },
    ]
  }
}

/** A scripted Apify: runs finish synchronously with the given items. */
export class FakeApify implements ApifyClient {
  started: { actor: string; input: Record<string, unknown>; max: number }[] = []
  runs = new Map<string, { run: RunData; items: unknown[] }>()
  posts: unknown[] = []
  comments: unknown[] = []
  finish = true
  usageUsd = 5
  async usage() {
    return { cycle: CYCLE, usageUsd: this.usageUsd }
  }
  async start(actor: string, input: Record<string, unknown>, max: number) {
    this.started.push({ actor, input, max })
    const id = `run${this.started.length}`
    const items = actor.includes('comments') ? this.comments : this.posts
    const run: RunData = { id, status: this.finish ? 'SUCCEEDED' : 'RUNNING', defaultDatasetId: `ds-${id}`, usageTotalUsd: 0.001 }
    this.runs.set(id, { run, items })
    return { ok: true as const, run: { ...run } }
  }
  async run(id: string) {
    return { ...this.runs.get(id)!.run }
  }
  async items(ds: string) {
    return this.runs.get(ds.replace('ds-', ''))!.items
  }
}
