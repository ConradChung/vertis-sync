// GTM-14: the filter stage machine for signal_people.
//   commenters: triage → verify → crawl → doors → contacts → draft → ready
//   reactors (inserted by C at 'crawl'): crawl → doors → contacts → draft → ready
// Each stage writes its result to the row (conditional on the row still being
// at that stage) before the next one runs, so a retry never pays twice for a
// finished step. Paid calls go through the Gate (caps first, then a settled
// comments_filter row with person_id). Two failures at a stage → 'error'.
// Only a crawl-confirmed PM (crawl_verdict 'property_manager') or a crawl-confirmed
// owner-operator (segment 'owner_operator', crawl_verdict 'owner_operator') can reach 'ready'.
// ICP gate (signal_config.icp, see icp.ts): by default only owner-operators continue (a PM
// company is skipped at verify, or before the crawl for reactors), a known count under
// min_units is skipped, and an unknown count after the doors step is parked at 'held'.
import { groundDoorCount, parseVerifyJson, type PplxAnswer, verifyParseRequest, doorQuestion } from '../influencer/verify.ts'
import { crawlPassed, OWNER_OPERATOR_CRAWL_RULES, OWNER_OPERATOR_VERDICT, ownerDoorQuestion, parseOwnerOperator, signalVerifyParseRequest } from './owner.ts'
import type { JsonRequest } from '../influencer/haiku.ts'
import { normalizeTarget } from '../research/crawl.ts'
import { type EmailLookup, personLinkedinUrl } from '../blitz.ts'
import { parseDoorsHint } from './doors.ts'
import { DEFAULT_ICP, type Icp, segmentAllowed, SKIP_PM_COMPANY, SKIP_UNDER_MIN_UNITS, SKIP_UNITS_UNKNOWN, unitGate } from './icp.ts'
import { buildDrafts, commenterOpening, type Facts, parseReply, REACTOR_PLACEHOLDER, type Reply, REPLY_EST_USD, replyRequest } from './drafts.ts'
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

/** contacts column: the person themself with the work email Blitz found ([] when none). */
export interface Contact { name: string; title: string | null; linkedin_url: string | null; email?: string | null }

/** The Blitz work-email lookup (BlitzSession): records-guarded, never throws. */
export interface EmailFinder {
  /** false once the records countdown is at 0, the key is missing/invalid, or Blitz is out for this tick */
  canSpend(cost?: number): Promise<boolean>
  findWorkEmail(linkedinUrl: string): Promise<EmailLookup>
}

export interface FilterDeps {
  store: Store
  gate: Gate
  now: () => Date
  /** ms left in the tick budget */
  timeLeft: () => number
  haiku(req: JsonRequest): Promise<{ json: unknown; usd: number }>
  perplexity(question: string): Promise<PplxAnswer>
  /** null when CRAWL_WORKER_URL / SECRET aren't set. */
  crawl: ((domains: string[], deadlineS: number, rules?: string) => Promise<CrawlResult[]>) | null
  email: EmailFinder
  facts: Facts
  reactorOpening: string | null
  /** signal_config.icp, parsed (readIcp). Absent → DEFAULT_ICP. */
  icp?: Icp
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

const icpOf = (d: FilterDeps): Icp => d.icp ?? DEFAULT_ICP

/**
 * Leaving the doors step: the unit gate decides. A count at or above min_units goes on to
 * contacts; a known count below it is skipped; an unknown count is held (or skipped /
 * continued, per icp.unknown_units).
 */
async function leaveDoors(d: FilterDeps, p: Person, patch: Partial<Person>, c: Counts, counter: string): Promise<void> {
  const count = patch.door_count !== undefined ? patch.door_count : p.door_count
  const g = unitGate(count, icpOf(d))
  if (g === 'continue') {
    if (await advance(d, p, 'doors', { ...patch, stage: 'contacts' })) bump(c, counter)
  } else if (g === 'hold') {
    if (await advance(d, p, 'doors', { ...patch, stage: 'held' })) bump(c, 'held_units_unknown')
  } else {
    const reason = typeof count === 'number' ? SKIP_UNDER_MIN_UNITS : SKIP_UNITS_UNKNOWN
    if (await skip(d, p, 'doors', reason, patch)) bump(c, `skipped_${reason}`)
  }
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
      const { json, usd } = await d.haiku(signalVerifyParseRequest(r.name ?? '', r.headline ?? '', a.answer, a.citations))
      await charge(d, r, 'haiku', usd)
      const p = groundDoorCount(parseVerifyJson(json), a.citations)
      // Owner-operator-only (the default ICP): someone who owns and self-manages rentals is the buyer,
      // even if they also manage; a PM company that is not one is skipped here, before any crawl spend.
      // With owner_operator_only off, the old rule holds: a PM company wins.
      const icp = icpOf(d)
      const owner = parseOwnerOperator(json)
      const segment = icp.owner_operator_only
        ? (owner ? 'owner_operator' : p.is_pm_company ? 'pm' : null)
        : (p.is_pm_company ? 'pm' : owner ? 'owner_operator' : null)
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
      if (!segment) {
        if (await skip(d, r, 'verify', 'not_pm', facts)) bump(c, 'skipped_not_pm')
      } else if (!segmentAllowed(segment, icp)) {
        if (await skip(d, r, 'verify', SKIP_PM_COMPANY, { ...facts, segment })) bump(c, 'skipped_pm_company')
      } else if (p.door_count !== null && unitGate(p.door_count, icp) === 'skip') {
        if (await skip(d, r, 'verify', SKIP_UNDER_MIN_UNITS, { ...facts, segment })) bump(c, 'skipped_under_min_units')
      } else if (!domainOf(p.company_website)) {
        if (await skip(d, r, 'verify', 'no_website', facts)) bump(c, 'skipped_no_website')
      } else if (await advance(d, r, 'verify', { ...facts, segment, stage: 'crawl' })) bump(c, segment === 'pm' ? 'verified' : 'verified_owner_operator')
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
    // Reactors skip verify: a PM-company reactor is dropped here, before the crawl is paid for.
    if (!segmentAllowed(p.segment, icpOf(d))) {
      if (await skip(d, p, 'crawl', SKIP_PM_COMPANY)) bump(c, 'skipped_pm_company')
    } else if (!domain) {
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
  // Owner-operators are checked with their own rules (a real rental operator, not a vendor).
  for (const owner of [false, true]) {
    const group = todo.filter((t) => (t.p.segment === 'owner_operator') === owner)
    if (group.length) await crawlGroup(d, c, group, deadlineS, owner)
  }
}

async function crawlGroup(d: FilterDeps, c: Counts, todo: { p: Person; domain: string }[], deadlineS: number, owner: boolean): Promise<void> {
  if (!d.crawl) return
  const domains = [...new Set(todo.map((t) => t.domain))]
  if (!(await d.gate.allow('comments_filter', r4(CRAWL_SITE_USD * domains.length)))) return
  let results: CrawlResult[]
  try {
    results = owner ? await d.crawl(domains, deadlineS, OWNER_OPERATOR_CRAWL_RULES) : await d.crawl(domains, deadlineS)
  } catch (err) {
    for (const t of todo) await fail(d, t.p, 'crawl', err, c)
    return
  }
  const byDomain = new Map<string, CrawlResult>()
  for (const r of results) byDomain.set(String(r.domain ?? '').toLowerCase().replace(/^www\./, ''), r)
  for (const { p, domain } of todo) {
    await charge(d, p, 'crawl', CRAWL_SITE_USD)
    const res = byDomain.get(domain)
    const raw = res?.verdict ?? 'timed_out'
    // Under the owner-operator rules a qualified site is stored as 'owner_operator', never as a PM.
    const verdict = owner && raw === 'property_manager' ? OWNER_OPERATOR_VERDICT : raw
    const base: Partial<Person> = { crawl_verdict: verdict, crawl_reason: res?.reason ?? null }
    if (verdict === 'property_manager' || verdict === OWNER_OPERATOR_VERDICT) {
      const hint = res?.doors_hint ?? null
      const patch: Partial<Person> = { ...base, doors_hint: hint, stage: 'doors' }
      const n = parseDoorsHint(hint)
      if (n !== null && p.door_count === null) {
        Object.assign(patch, { door_count: n, door_count_source: p.company_website, door_count_confidence: 'medium' })
      }
      if (await advance(d, p, 'crawl', patch)) bump(c, owner ? 'crawled_owner_operator' : 'crawled_pm')
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
      await leaveDoors(d, r, {}, c, 'doors_known')
      continue
    }
    if (d.timeLeft() < 45_000) return
    if (!(await d.gate.allow('comments_filter', PPLX_EST_USD))) return
    try {
      const a = await d.perplexity(r.segment === 'owner_operator'
        ? ownerDoorQuestion(r.company_name ?? '', r.location ?? '')
        : doorQuestion(r.company_name ?? '', r.location ?? ''))
      await charge(d, r, 'doors', a.cost)
      const { json, usd } = await d.haiku(verifyParseRequest(r.name ?? '', r.headline ?? '', a.answer, a.citations))
      await charge(d, r, 'haiku', usd)
      const p = groundDoorCount(parseVerifyJson(json), a.citations)
      const patch: Partial<Person> = {}
      if (p.door_count !== null) {
        Object.assign(patch, { door_count: p.door_count, door_count_source: p.door_count_source, door_count_confidence: p.door_count_confidence })
      }
      await leaveDoors(d, r, patch, c, p.door_count !== null ? 'doors_found' : 'doors_none')
    } catch (err) {
      // The second failure leaves the doors step without a count; the unit gate decides (held by default).
      if ((r.attempts ?? 0) + 1 >= MAX_ATTEMPTS) {
        await leaveDoors(d, r, { last_error: `doors: ${msg(err)}` }, c, 'doors_failed')
      } else await fail(d, r, 'doors', err, c)
    }
  }
}

// The person's own verified work email, from Blitz by their LinkedIn URL. Blitz
// costs records, not dollars (1 on a hit, 0 on a miss), so the gate here is the
// records guard rather than a USD estimate. Best effort: a miss, a missing key,
// exhausted records or an outage ships the card with contacts [] and no retry.
export async function stageContacts(d: FilterDeps, c: Counts, kind: 'commenter' | 'reactor'): Promise<void> {
  const rows = await d.store.peopleAt('contacts', kind, 10)
  for (const r of rows) {
    if (d.timeLeft() < 15_000) return
    let contacts: Contact[] = []
    const url = personLinkedinUrl(r.linkedin_url)
    if (url && (await d.email.canSpend(1))) {
      const res = await d.email.findWorkEmail(url)
      if (res.kind === 'found') {
        contacts = [{ name: (r.name ?? '').trim(), title: r.title ?? null, linkedin_url: r.linkedin_url, email: res.email }]
        bump(c, 'email_found')
      } else bump(c, res.kind === 'miss' ? 'email_miss' : `email_unavailable_${res.reason}`)
    } else bump(c, url ? 'email_unavailable' : 'email_no_profile')
    if (await advance(d, r, 'contacts', { contacts, stage: 'draft' })) bump(c, 'contacts')
  }
}

export async function stageDraft(d: FilterDeps, c: Counts, kind: 'commenter' | 'reactor'): Promise<void> {
  const rows = await d.store.peopleAt('draft', kind, 25)
  for (const r of rows) {
    // Hard rule: only a crawl-confirmed PM or owner-operator can be alerted. Vendors never reach 'ready'.
    if (!crawlPassed(r)) {
      if (await skip(d, r, 'draft', 'vendor')) bump(c, 'skipped_vendor')
      continue
    }
    const company = r.company_name ?? r.company_guess
    const opening = r.kind === 'commenter'
      ? commenterOpening(r.commented_at, d.now())
      : (d.reactorOpening?.trim() || REACTOR_PLACEHOLDER)
    // The response to their comment (Haiku, from the comment text only). The first failure retries
    // next tick; after that the card ships with the plain opening rather than not at all.
    let reply: Reply | null = null
    const comment = (r.comment_text ?? '').trim()
    if (r.kind === 'commenter' && comment && (r.attempts ?? 0) < 1) {
      if (d.timeLeft() < 20_000) return
      if (!(await d.gate.allow('comments_filter', REPLY_EST_USD))) return
      try {
        // Two tries in this tick (a rejected reply is cheap to redo); then the row retries next tick.
        for (let i = 0; i < 2 && !reply; i++) {
          const { json, usd } = await d.haiku(replyRequest({ first_name: r.first_name, company_name: company, comment, opening }))
          await charge(d, r, 'haiku', usd)
          try {
            reply = parseReply(json, opening, r.first_name, `${comment}\n${company ?? ''}`) // their company name may carry digits
          } catch (err) {
            if (i === 1) throw err
          }
        }
      } catch (err) {
        await d.store.patchPerson(r.id, { attempts: 1, last_error: `draft: ${msg(err)}` }, 'draft')
        bump(c, 'draft_retry')
        continue
      }
    }
    try {
      const drafts = buildDrafts({ first_name: r.first_name, company_name: company, opening, reply }, d.facts)
      if (await advance(d, r, 'draft', { drafts: drafts as unknown, connected: null, stage: assertReady(r) })) bump(c, 'ready')
    } catch (err) {
      await fail(d, r, 'draft', err, c)
    }
  }
}

/** The one way a row becomes 'ready'. Throws unless the crawl worker confirmed a PM (or an owner-operator). */
export function assertReady(p: Pick<Person, 'crawl_verdict' | 'segment'>): 'ready' {
  if (!crawlPassed(p)) throw new Error('only a crawl-confirmed property manager or owner-operator can reach ready')
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
  return async (domains: string[], deadlineS = CRAWL_DEADLINE_S, rules?: string): Promise<CrawlResult[]> => {
    const res = await f(`${url.replace(/\/+$/, '')}/classify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Worker-Secret': secret },
      body: JSON.stringify({ domains: domains.slice(0, CRAWL_BATCH), deadline_s: deadlineS, ...(rules ? { rules } : {}) }),
      signal: AbortSignal.timeout((deadlineS + 10) * 1000),
    })
    if (!res.ok) throw new Error(`crawl worker ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const body = await res.json() as { results?: unknown }
    if (!Array.isArray(body?.results)) throw new Error('crawl worker: no results')
    return body.results as CrawlResult[]
  }
}
