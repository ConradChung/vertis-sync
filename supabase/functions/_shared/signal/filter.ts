// GTM-14: the filter stage machine for signal_people.
//   commenters: triage → verify → crawl → doors → contacts → draft → ready
//   reactors (inserted by C at 'crawl'): crawl → doors → contacts → draft → ready
// Each stage writes its result to the row (conditional on the row still being
// at that stage) before the next one runs, so a retry never pays twice for a
// finished step. Paid calls go through the Gate (caps first, then a settled
// comments_filter row with person_id). Two failures at a stage → 'error'.
// Only crawl_verdict = 'property_manager' can reach 'ready'.
import { groundDoorCount, parseVerifyJson, type PplxAnswer, verifyParseRequest, doorQuestion } from '../influencer/verify.ts'
import type { JsonRequest } from '../influencer/haiku.ts'
import { normalizeTarget } from '../research/crawl.ts'
import { profileSlug } from './comments.ts'
import { parseDoorsHint } from './doors.ts'
import { buildDrafts, commenterOpening, type Facts, REACTOR_PLACEHOLDER } from './drafts.ts'
import type { Gate } from './gate.ts'
import type { Person, Stage, Store } from './store.ts'
import { parseSignalTriage, SIGNAL_TRIAGE_BATCH, signalTriageRequest, signalVerificationQuestion } from './triage.ts'

export const MAX_ATTEMPTS = 2
export const TRIAGE_EST_USD = 0.005
export const PPLX_EST_USD = 0.012
export const CRAWL_SITE_USD = 0.0002
export const CRAWL_BATCH = 10
export const CRAWL_DEADLINE_S = 90

export interface CrawlResult {
  domain: string
  verdict: 'property_manager' | 'not_property_manager' | 'unreachable' | 'error' | 'timed_out' | string
  confidence?: string | null
  reason?: string | null
  linkedin_url?: string | null
  doors_hint?: string | null
  property_type?: string | null
}

export interface Contact { name: string; title: string | null; linkedin_url: string | null }

export interface FilterDeps {
  store: Store
  gate: Gate
  now: () => Date
  /** ms left in the tick budget */
  timeLeft: () => number
  haiku(req: JsonRequest): Promise<{ json: unknown; usd: number }>
  perplexity(question: string): Promise<PplxAnswer>
  /** null when CRAWL_WORKER_URL / SECRET aren't set. */
  crawl: ((domains: string[], deadlineS: number) => Promise<CrawlResult[]>) | null
  apollo(domain: string): Promise<Contact[]>
  facts: Facts
  reactorOpening: string | null
}

export type Counts = Record<string, number>
const bump = (c: Counts, k: string, n = 1) => (c[k] = (c[k] ?? 0) + n)
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500)

/** Next stage with attempts reset; only if the row is still at `from`. */
function advance(d: FilterDeps, p: Person, from: Stage, patch: Partial<Person>) {
  return d.store.patchPerson(p.id, { attempts: 0, last_error: null, ...patch }, from)
}

function skip(d: FilterDeps, p: Person, from: Stage, reason: string, patch: Partial<Person> = {}) {
  return d.store.patchPerson(p.id, { ...patch, stage: 'skipped', skip_reason: reason }, from)
}

/** A failed attempt; the second one parks the row at 'error'. */
async function fail(d: FilterDeps, p: Person, at: Stage, err: unknown, c: Counts) {
  const attempts = (p.attempts ?? 0) + 1
  const patch: Partial<Person> = { attempts, last_error: `${at}: ${msg(err)}` }
  if (attempts >= MAX_ATTEMPTS) patch.stage = 'error'
  await d.store.patchPerson(p.id, patch, at)
  bump(c, attempts >= MAX_ATTEMPTS ? 'error' : `${at}_retry`)
}

const r4 = (n: number) => Math.round(n * 10_000) / 10_000
const ceil4 = (n: number) => Math.ceil(n * 10_000 - 1e-9) / 10_000

async function charge(d: FilterDeps, p: Person, kind: string, usd: number) {
  if (usd <= 0) return
  await d.gate.record(kind, usd, { person_id: p.id })
  p.spend_usd = r4(Number(p.spend_usd ?? 0) + usd)
  await d.store.patchPerson(p.id, { spend_usd: p.spend_usd })
}

export const domainOf = (website: string | null | undefined): string | null => {
  if (!website?.trim()) return null
  const t = normalizeTarget({ url: website })
  return 'domain' in t ? t.domain : null
}

// ---------------------------------------------------------------------------

export async function stageTriage(d: FilterDeps, c: Counts): Promise<void> {
  const rows = await d.store.peopleAt('triage', 'commenter', SIGNAL_TRIAGE_BATCH)
  if (!rows.length) return
  const blank = rows.filter((r) => !(r.headline ?? '').trim())
  for (const r of blank) if (await skip(d, r, 'triage', 'triage_no', { triage: 'no' })) bump(c, 'skipped_triage_no')
  const ask = rows.filter((r) => (r.headline ?? '').trim())
  if (!ask.length || d.timeLeft() < 35_000) return
  if (!(await d.gate.allow('comments_filter', TRIAGE_EST_USD))) return
  let res
  try {
    res = await d.haiku(signalTriageRequest(ask.map((r) => ({ id: r.id, headline: r.headline }))))
  } catch (err) {
    for (const r of ask) await fail(d, r, 'triage', err, c)
    return
  }
  const share = ceil4(res.usd / ask.length)
  let labels
  try {
    labels = parseSignalTriage(res.json, ask.map((r) => r.id))
  } catch (err) {
    for (const r of ask) {
      await charge(d, r, 'haiku', share)
      await fail(d, r, 'triage', err, c)
    }
    return
  }
  for (const r of ask) {
    await charge(d, r, 'haiku', share)
    const t = labels[r.id]
    const ok = t.label === 'no'
      ? await skip(d, r, 'triage', 'triage_no', { triage: 'no', company_guess: t.company })
      : await advance(d, r, 'triage', { triage: t.label, company_guess: t.company, stage: 'verify' })
    if (ok) bump(c, t.label === 'no' ? 'skipped_triage_no' : 'triaged')
  }
}

export async function stageVerify(d: FilterDeps, c: Counts): Promise<void> {
  const rows = await d.store.peopleAt('verify', 'commenter', 10)
  for (const r of rows) {
    if (d.timeLeft() < 45_000) return
    if (!(await d.gate.allow('comments_filter', PPLX_EST_USD))) return
    try {
      const a = await d.perplexity(signalVerificationQuestion(r.name ?? '', r.headline ?? '', r.company_guess))
      await charge(d, r, 'perplexity', a.cost)
      const { json, usd } = await d.haiku(verifyParseRequest(r.name ?? '', r.headline ?? '', a.answer, a.citations))
      await charge(d, r, 'haiku', usd)
      const p = groundDoorCount(parseVerifyJson(json), a.citations)
      const facts: Partial<Person> = {
        company_name: p.company_name || r.company_guess || null,
        company_website: p.company_website || null,
        title: p.title || null,
        location: p.location || null,
        is_decision_maker: p.is_decision_maker,
        door_count: p.door_count,
        door_count_source: p.door_count_source || null,
        door_count_confidence: p.door_count_confidence || null,
      }
      if (!p.is_pm_company) {
        if (await skip(d, r, 'verify', 'not_pm', facts)) bump(c, 'skipped_not_pm')
      } else if (!domainOf(p.company_website)) {
        if (await skip(d, r, 'verify', 'no_website', facts)) bump(c, 'skipped_no_website')
      } else if (await advance(d, r, 'verify', { ...facts, stage: 'crawl' })) bump(c, 'verified')
    } catch (err) {
      await fail(d, r, 'verify', err, c)
    }
  }
}

export async function stageCrawl(d: FilterDeps, c: Counts, kind: 'commenter' | 'reactor'): Promise<void> {
  const rows = await d.store.peopleAt('crawl', kind, CRAWL_BATCH)
  if (!rows.length) return
  const todo: { p: Person; domain: string }[] = []
  for (const p of rows) {
    const domain = domainOf(p.company_website)
    if (!domain) {
      if (await skip(d, p, 'crawl', 'no_website')) bump(c, 'skipped_no_website')
    } else todo.push({ p, domain })
  }
  if (!todo.length) return
  if (!d.crawl) {
    bump(c, 'crawl_unconfigured')
    return
  }
  // The worker returns what finished by the deadline (the rest as timed_out): fit it into the tick.
  const deadlineS = Math.min(CRAWL_DEADLINE_S, Math.floor(d.timeLeft() / 1000) - 15)
  if (deadlineS < 15) return
  const domains = [...new Set(todo.map((t) => t.domain))]
  if (!(await d.gate.allow('comments_filter', r4(CRAWL_SITE_USD * domains.length)))) return
  let results: CrawlResult[]
  try {
    results = await d.crawl(domains, deadlineS)
  } catch (err) {
    for (const t of todo) await fail(d, t.p, 'crawl', err, c)
    return
  }
  const byDomain = new Map<string, CrawlResult>()
  for (const r of results) byDomain.set(String(r.domain ?? '').toLowerCase().replace(/^www\./, ''), r)
  for (const { p, domain } of todo) {
    await charge(d, p, 'crawl', CRAWL_SITE_USD)
    const res = byDomain.get(domain)
    const verdict = res?.verdict ?? 'timed_out'
    const base: Partial<Person> = { crawl_verdict: verdict, crawl_reason: res?.reason ?? null }
    if (verdict === 'property_manager') {
      const hint = res?.doors_hint ?? null
      const patch: Partial<Person> = { ...base, doors_hint: hint, stage: 'doors' }
      const n = parseDoorsHint(hint)
      if (n !== null && p.door_count === null) {
        Object.assign(patch, { door_count: n, door_count_source: p.company_website, door_count_confidence: 'medium' })
      }
      if (await advance(d, p, 'crawl', patch)) bump(c, 'crawled_pm')
    } else if (verdict === 'not_property_manager') {
      if (await skip(d, p, 'crawl', 'vendor', base)) bump(c, 'skipped_vendor')
    } else if (verdict === 'unreachable' || verdict === 'error') {
      if ((p.attempts ?? 0) >= 1) {
        if (await skip(d, p, 'crawl', 'unreachable', base)) bump(c, 'skipped_unreachable')
      } else {
        await d.store.patchPerson(p.id, { ...base, attempts: 1, last_error: `crawl: ${verdict}` }, 'crawl')
        bump(c, 'crawl_retry')
      }
    } else {
      // timed_out (or a result missing for the domain): retry next tick, no attempt used.
      await d.store.patchPerson(p.id, base, 'crawl')
      bump(c, 'crawl_timed_out')
    }
  }
}

export async function stageDoors(d: FilterDeps, c: Counts, kind: 'commenter' | 'reactor'): Promise<void> {
  const rows = await d.store.peopleAt('doors', kind, 10)
  for (const r of rows) {
    // Already counted (verify's cited count, or a numeric crawl hint), or a reactor (no paid calls): move on.
    if (r.door_count !== null || kind === 'reactor') {
      if (await advance(d, r, 'doors', { stage: 'contacts' })) bump(c, 'doors_known')
      continue
    }
    if (d.timeLeft() < 45_000) return
    if (!(await d.gate.allow('comments_filter', PPLX_EST_USD))) return
    try {
      const a = await d.perplexity(doorQuestion(r.company_name ?? '', r.location ?? ''))
      await charge(d, r, 'doors', a.cost)
      const { json, usd } = await d.haiku(verifyParseRequest(r.name ?? '', r.headline ?? '', a.answer, a.citations))
      await charge(d, r, 'haiku', usd)
      const p = groundDoorCount(parseVerifyJson(json), a.citations)
      const patch: Partial<Person> = { stage: 'contacts' }
      if (p.door_count !== null) {
        Object.assign(patch, { door_count: p.door_count, door_count_source: p.door_count_source, door_count_confidence: p.door_count_confidence })
      }
      if (await advance(d, r, 'doors', patch)) bump(c, p.door_count !== null ? 'doors_found' : 'doors_none')
    } catch (err) {
      // The door count is optional: the second failure moves on without one instead of parking the lead.
      if ((r.attempts ?? 0) + 1 >= MAX_ATTEMPTS) {
        if (await advance(d, r, 'doors', { stage: 'contacts', last_error: `doors: ${msg(err)}` })) bump(c, 'doors_failed')
      } else await fail(d, r, 'doors', err, c)
    }
  }
}

export async function stageContacts(d: FilterDeps, c: Counts, kind: 'commenter' | 'reactor'): Promise<void> {
  const rows = await d.store.peopleAt('contacts', kind, 10)
  for (const r of rows) {
    if (d.timeLeft() < 15_000) return
    let contacts: Contact[] = []
    const domain = domainOf(r.company_website)
    if (domain) {
      try {
        // Best effort (Apollo Free plan may 403): any failure ships with no contacts, no retry.
        const slug = profileSlug(r.linkedin_url)
        const self = (r.name ?? '').trim().toLowerCase()
        contacts = (await d.apollo(domain))
          .filter((x) => !(slug && profileSlug(x.linkedin_url) === slug) && !(self && x.name.trim().toLowerCase() === self))
          .slice(0, 3)
      } catch {
        contacts = []
      }
    }
    if (await advance(d, r, 'contacts', { contacts, stage: 'draft' })) bump(c, 'contacts')
  }
}

export async function stageDraft(d: FilterDeps, c: Counts, kind: 'commenter' | 'reactor'): Promise<void> {
  const rows = await d.store.peopleAt('draft', kind, 25)
  for (const r of rows) {
    // Hard rule: only a crawl-confirmed property manager can be alerted. Vendors never reach 'ready'.
    if (r.crawl_verdict !== 'property_manager') {
      if (await skip(d, r, 'draft', 'vendor')) bump(c, 'skipped_vendor')
      continue
    }
    try {
      const opening = r.kind === 'commenter'
        ? commenterOpening(r.commented_at, d.now())
        : (d.reactorOpening?.trim() || REACTOR_PLACEHOLDER)
      const drafts = buildDrafts({ first_name: r.first_name, company_name: r.company_name ?? r.company_guess, opening }, d.facts)
      if (await advance(d, r, 'draft', { drafts: drafts as unknown, connected: null, stage: assertReady(r) })) bump(c, 'ready')
    } catch (err) {
      await fail(d, r, 'draft', err, c)
    }
  }
}

/** The one way a row becomes 'ready'. Throws unless the crawl worker said property_manager. */
export function assertReady(p: Pick<Person, 'crawl_verdict'>): 'ready' {
  if (p.crawl_verdict !== 'property_manager') throw new Error('only crawl_verdict=property_manager can reach ready')
  return 'ready'
}

export async function runCommenterStages(d: FilterDeps, c: Counts): Promise<void> {
  await stageTriage(d, c)
  await stageVerify(d, c)
  await stageCrawl(d, c, 'commenter')
  await stageDoors(d, c, 'commenter')
  await stageContacts(d, c, 'commenter')
  await stageDraft(d, c, 'commenter')
}

export async function runReactorStages(d: FilterDeps, c: Counts): Promise<void> {
  await stageCrawl(d, c, 'reactor')
  await stageDoors(d, c, 'reactor')
  await stageContacts(d, c, 'reactor')
  await stageDraft(d, c, 'reactor')
}

// ---------------------------------------------------------------------------
// HTTP adapters (used by the edge function; tests inject fakes)

export function crawlClient(url: string, secret: string, f: typeof fetch = fetch) {
  return async (domains: string[], deadlineS = CRAWL_DEADLINE_S): Promise<CrawlResult[]> => {
    const res = await f(`${url.replace(/\/+$/, '')}/classify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Worker-Secret': secret },
      body: JSON.stringify({ domains: domains.slice(0, CRAWL_BATCH), deadline_s: deadlineS }),
      signal: AbortSignal.timeout((deadlineS + 10) * 1000),
    })
    if (!res.ok) throw new Error(`crawl worker ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const body = await res.json() as { results?: unknown }
    if (!Array.isArray(body?.results)) throw new Error('crawl worker: no results')
    return body.results as CrawlResult[]
  }
}

export const APOLLO_URL = 'https://api.apollo.io/api/v1/mixed_people/api_search'
export const APOLLO_TITLES = ['owner', 'president', 'ceo', 'coo', 'founder', 'director of property management', 'vp operations', 'principal']

export function apolloClient(key: string, f: typeof fetch = fetch) {
  return async (domain: string): Promise<Contact[]> => {
    if (!key) throw new Error('APOLLO_API_KEY not set')
    const res = await f(APOLLO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'Cache-Control': 'no-cache' },
      body: JSON.stringify({ q_organization_domains_list: [domain], person_titles: APOLLO_TITLES, per_page: 5 }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      await res.body?.cancel()
      throw new Error(`apollo ${res.status}`)
    }
    const body = await res.json() as { people?: unknown }
    const people = Array.isArray(body?.people) ? body.people as Record<string, unknown>[] : []
    return people.map((p) => ({
      name: String(p.name ?? [p.first_name, p.last_name].filter(Boolean).join(' ')).trim(),
      title: typeof p.title === 'string' ? p.title : null,
      linkedin_url: typeof p.linkedin_url === 'string' ? p.linkedin_url : null,
    })).filter((p) => p.name)
  }
}
