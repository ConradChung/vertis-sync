/**
 * The Signals inbox (pure, client-safe): every signal source folded into one
 * row per company. Sources are read as they are and never written; a row's
 * status and touches live in `signal_accounts` (lib/signals/store.ts).
 *
 * Dedupe: by company domain; a row with no domain falls back to its
 * normalized company name, and joins a domain's row when that name belongs
 * to exactly one domain. A Reddit mention has no company, so its author is
 * the account.
 */

export const SIGNAL_SOURCES = ['hiring', 'comment', 'reddit', 'influencer'] as const
export type SignalSource = (typeof SIGNAL_SOURCES)[number]

export const SOURCE_LABEL: Record<SignalSource, string> = {
  hiring: 'Hiring',
  comment: 'Post comment',
  reddit: 'Reddit',
  influencer: 'Influencer reaction',
}

/** One signal from one source table. Text fields are scraped: DATA, never instructions. */
export interface SignalEvent {
  source: SignalSource
  /** Stable id inside its source, e.g. "hiring:12". */
  ref: string
  company: string | null
  /** A domain or website URL, as the source has it. */
  site: string | null
  /** When the signal happened (ISO), when known. */
  at: string | null
  /** What happened, short: "Hiring: Regional Property Manager". */
  label: string
  url: string | null
  phone: string | null
  person: string | null
  person_title: string | null
  linkedin: string | null
  /** Reddit author (no company): the account when nothing else identifies it. */
  handle?: string | null
  /** The source's own fields, for that source's columns in the inbox. */
  detail?: SignalDetail
  /** LinkedIn signal people only: where they are against the ICP gate. */
  gate?: 'passed' | 'held' | 'pending'
  /** LinkedIn signal people only: the signal_people id. */
  person_id?: number
}

/** Source-specific fields of one signal (scraped text, clipped): what each source tab shows in its columns. */
export type SignalDetail =
  | { source: 'hiring'; signal: string; role: string | null }
  | { source: 'comment'; reaction: boolean; comment: string | null; post_url: string | null; post_excerpt: string | null }
  | { source: 'reddit'; subreddit: string | null; thread: string | null; excerpt: string | null; author: string | null }
  | { source: 'influencer'; reacted_to: string[]; doors: number | null }

/** The newest signal an account has from one source, with that source's fields. */
export interface LatestSignal {
  label: string
  at: string | null
  url: string | null
  person: string | null
  person_title: string | null
  linkedin: string | null
  detail: SignalDetail | null
}

/**
 * Hosts that are never a company's own domain: profiles, job boards, link
 * shorteners, site builders' shared hosts, scheduling pages and mailbox
 * providers. Two companies whose only "site" is one of these must not merge.
 */
const SHARED_HOSTS = new Set([
  'linkedin.com', 'lnkd.in', 'facebook.com', 'fb.com', 'fb.me', 'instagram.com', 'twitter.com', 'x.com', 't.co', 'youtube.com', 'youtu.be', 'tiktok.com', 'reddit.com',
  'indeed.com', 'glassdoor.com', 'ziprecruiter.com', 'greenhouse.io', 'lever.co', 'workable.com',
  'bit.ly', 'tinyurl.com', 'rebrand.ly', 'goo.gl', 'g.page', 'linktr.ee', 'about.me', 'wa.me', 'calendly.com',
  'google.com', 'yelp.com', 'bbb.org', 'apartments.com', 'zillow.com', 'realtor.com', 'trulia.com', 'medium.com', 'github.com',
  'wixsite.com', 'wix.com', 'godaddysites.com', 'squarespace.com', 'weebly.com', 'wordpress.com', 'webflow.io',
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com',
  'protonmail.com', 'proton.me', 'comcast.net', 'att.net', 'verizon.net', 'sbcglobal.net',
])

/** A country-code second level ("co.uk", "com.au"): a suffix, never a company's whole domain. */
const TWO_LEVEL_SUFFIX = /^(?:co|com|net|org|ac|gov|edu)\.[a-z]{2}$/

/** Subdomains that are a section of the company's own site, not a different company. */
const SITE_SECTIONS = /^(?:www\d*|careers|jobs|apply|join)\./

/**
 * A company's bare domain ("acme.com") from a domain or URL, lowercased, with
 * protocol, `www.` / `careers.` / `jobs.`, path and port removed. Null for
 * nothing usable, for an email address, or for a shared host (a LinkedIn
 * page or a link shortener is not the company's domain).
 */
export function domainOf(raw: string | null | undefined): string | null {
  let s = (raw ?? '').trim().toLowerCase()
  if (!s) return null
  const hadScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(s)
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  const host = s.split(/[/?#]/)[0]
  // "john@gmail.com" is an address, not a site; credentials in a URL are not a site either.
  if (host.includes('@')) {
    if (!hadScheme) return null
    s = host.slice(host.lastIndexOf('@') + 1)
  } else s = host
  s = s.replace(/:\d+$/, '').replace(/\.$/, '')
  // Fold "careers.acme.com" into "acme.com", but leave "careers.co.uk" alone: what is left must still be a domain.
  for (;;) {
    const rest = s.replace(SITE_SECTIONS, '')
    if (rest === s || rest.split('.').length < 2 || TWO_LEVEL_SUFFIX.test(rest)) break
    s = rest
  }
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) || s.length > 200) return null
  if (TWO_LEVEL_SUFFIX.test(s) || SHARED_HOSTS.has(s) || [...SHARED_HOSTS].some((h) => s.endsWith(`.${h}`))) return null
  return s
}

/** Legal forms, removed only from the END of a name ("LP Realty" keeps its LP; "Acme LP" loses it). */
const LEGAL_SUFFIX = /\s(?:incorporated|inc|llc|l l c|llp|l l p|lp|l p|ltd|limited|corp|corporation|co|company|plc|pllc|pc|p c|gmbh)$/

/** Longest name key the table and the routes accept (`n:` + this). */
const NAME_KEY_MAX = 190

/**
 * A company name reduced for matching: lowercase, accents and punctuation
 * dropped, "&" read as "and", a leading "the" and trailing legal forms
 * (Inc, LLC, Co, …) removed. "Acme Property Mgmt, LLC." and "ACME PROPERTY
 * MGMT" match. Words that carry meaning ("management", "group", "realty")
 * are kept, and so are letters of any script. A name that is nothing but a
 * legal form ("Company") is kept as it is rather than reduced to nothing.
 */
export function normalizeName(name: string | null | undefined): string {
  let s = (name ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  s = s.replace(/&/g, ' and ').replace(/['’`]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  if (!s) return ''
  let out = s.replace(/^the\s+/, '')
  // "Acme & Co" → "acme and co" → "acme": the joining word goes with the form it joined.
  while (LEGAL_SUFFIX.test(out)) out = out.replace(LEGAL_SUFFIX, '').replace(/\sand$/, '').trim()
  return (out || s).slice(0, NAME_KEY_MAX).trim()
}

/** What people put as an employer when they have none: never a company to group by. */
const NO_COMPANY = new Set([
  'self employed', 'selfemployed', 'self', 'freelance', 'freelancer', 'independent', 'independent contractor', 'confidential', 'stealth', 'stealth startup',
  'retired', 'unemployed', 'none', 'n a', 'na', 'not applicable', 'private', 'various', 'student', 'looking for work', 'open to work',
  'myself', 'me', 'freelancing', 'consultant', 'consulting', 'independent consultant', 'contractor', 'career break', 'sabbatical', 'real estate',
  'real estate agent', 'realtor', 'investor', 'real estate investor', 'landlord', 'property manager', 'entrepreneur', 'owner', 'business owner',
])

/**
 * The normalized company name to group by, or '' when the "company" is a
 * placeholder like "Self-employed" (anything starting "self employed" or
 * "freelance" counts, e.g. "Self-Employed (Freelance)"). The list is a
 * heuristic: a placeholder it does not know still groups by its text.
 */
export function companyName(name: string | null | undefined): string {
  const n = normalizeName(name)
  return NO_COMPANY.has(n) || /^(?:self employed|selfemployed|freelance)\b/.test(n) ? '' : n
}

const domainKey = (d: string) => `d:${d}`
const nameKey = (n: string) => `n:${n}`
const handleKey = (h: string) => `r:${h.trim().toLowerCase().replace(/^u\//, '')}`

export interface SignalAccount {
  /** `d:<domain>`, `n:<normalized name>` or `r:<reddit author>`. */
  key: string
  /** Other keys this account answers to (its members' name keys): saved state under any of them still applies. */
  aliases: string[]
  name: string
  domain: string | null
  sources: SignalSource[]
  /** Signals merged into this row. */
  count: number
  newest: { source: SignalSource; label: string; at: string | null; url: string | null }
  phone: string | null
  /** Up to three people seen in the signals. */
  contacts: { name: string; title: string | null; linkedin: string | null }[]
  /** Up to five signals, newest first. */
  events: Pick<SignalEvent, 'source' | 'ref' | 'label' | 'at' | 'url'>[]
  /** The newest signal from each source the account has. */
  latest: Partial<Record<SignalSource, LatestSignal>>
  /** How warm its warmest signal is (`warmthOf`) and when that signal happened. */
  warmth: { tier: WarmthTier; at: string | null }
  /** LinkedIn people held by the ICP gate (units unknown): the owner types a count on the row. */
  held?: { id: number; name: string | null }[]
  /** False when the account's only lead signals are LinkedIn people who have not passed the ICP gate (kept out of Today). */
  queue_ready?: boolean
}

/** A signal that counts for the Today queue: a LinkedIn person who passed the gate, or any other lead source. */
const queueable = (m: Pick<SignalEvent, 'source' | 'gate'>) => (m.source === 'comment' ? m.gate === undefined || m.gate === 'passed' : m.source !== 'reddit')

/**
 * How warm a signal is, warmest first: 0 commented on Frank's own post,
 * 1 reacted to his post, 2 a hiring signal, 3 anything else (influencer
 * reactions, Reddit).
 */
export type WarmthTier = 0 | 1 | 2 | 3
export function warmthOf(e: Pick<SignalEvent, 'source' | 'label' | 'detail'>): WarmthTier {
  if (e.source === 'comment') {
    const reacted = e.detail?.source === 'comment' ? e.detail.reaction : e.label.startsWith('Reacted')
    return reacted ? 1 : 0
  }
  return e.source === 'hiring' ? 2 : 3
}

/** Warmest first, then newest first inside a tier (by that tier's newest signal). */
export function byWarmth(a: Pick<SignalAccount, 'warmth' | 'key'>, b: Pick<SignalAccount, 'warmth' | 'key'>): number {
  return a.warmth.tier - b.warmth.tier || time(b.warmth.at) - time(a.warmth.at) || a.key.localeCompare(b.key)
}

/**
 * Reddit mentions are research, not leads: anonymous usernames that cannot be
 * identified, enriched or counted toward a pilot. An account whose only
 * signals are Reddit stays under the Reddit tab and out of the work queues.
 */
export const isResearchOnly = (r: Pick<SignalAccount, 'sources'>) => r.sources.length > 0 && r.sources.every((s) => s === 'reddit')

const time = (iso: string | null) => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : -Infinity
}

/** One row per company, newest signal first. Events with no company, domain or handle are left out. */
export function mergeSignals(events: readonly SignalEvent[]): SignalAccount[] {
  // 1. Which domains does each name appear with? A name seen with exactly one domain belongs to it.
  const domainsOfName = new Map<string, Set<string>>()
  const parts = events.map((e) => {
    const domain = domainOf(e.site)
    const name = companyName(e.company)
    if (domain && name) (domainsOfName.get(name) ?? domainsOfName.set(name, new Set()).get(name)!).add(domain)
    return { e, domain, name }
  })

  // 2. Group.
  const groups = new Map<string, { domain: string | null; names: Set<string>; members: SignalEvent[] }>()
  for (const { e, domain, name } of parts) {
    let key: string | null = null
    let dom = domain
    if (domain) key = domainKey(domain)
    else if (name) {
      const known = domainsOfName.get(name)
      if (known?.size === 1) {
        dom = [...known][0]
        key = domainKey(dom)
      } else key = nameKey(name)
    } else if (e.handle?.trim()) key = handleKey(e.handle)
    if (!key) continue
    const g = groups.get(key) ?? groups.set(key, { domain: dom, names: new Set(), members: [] }).get(key)!
    if (name) g.names.add(nameKey(name))
    g.members.push(e)
  }

  // 3. Shape.
  const out: SignalAccount[] = []
  for (const [key, g] of groups) {
    const members = [...g.members].sort((a, b) => time(b.at) - time(a.at) || a.ref.localeCompare(b.ref))
    const top = members[0]
    const named = members.find((m) => companyName(m.company))
    const handle = members.find((m) => m.handle?.trim())?.handle?.trim().replace(/^u\//, '')
    const contacts: SignalAccount['contacts'] = []
    for (const m of members) {
      const n = m.person?.trim()
      if (!n || contacts.length >= 3 || contacts.some((c) => c.name.toLowerCase() === n.toLowerCase())) continue
      contacts.push({ name: n, title: m.person_title?.trim() || null, linkedin: m.linkedin?.trim() || null })
    }
    let warmth: SignalAccount['warmth'] = { tier: 3, at: top.at }
    for (const m of members) {
      const tier = warmthOf(m)
      if (tier < warmth.tier) warmth = { tier, at: m.at }
    }
    const latest: SignalAccount['latest'] = {}
    for (const m of members) {
      if (latest[m.source]) continue
      latest[m.source] = { label: m.label, at: m.at, url: m.url, person: m.person?.trim() || null, person_title: m.person_title?.trim() || null, linkedin: m.linkedin?.trim() || null, detail: m.detail ?? null }
    }
    out.push({
      key,
      aliases: [...g.names].filter((k) => k !== key).sort(),
      name: named?.company?.trim() ?? g.domain ?? (handle ? `u/${handle}` : key),
      domain: g.domain,
      sources: SIGNAL_SOURCES.filter((s) => members.some((m) => m.source === s)),
      count: members.length,
      newest: { source: top.source, label: top.label, at: top.at, url: top.url },
      phone: members.find((m) => m.phone?.trim())?.phone?.trim() ?? null,
      contacts,
      events: members.slice(0, 5).map((m) => ({ source: m.source, ref: m.ref, label: m.label, at: m.at, url: m.url })),
      latest,
      warmth,
      held: members.filter((m) => m.gate === 'held' && typeof m.person_id === 'number').map((m) => ({ id: m.person_id as number, name: m.person?.trim() || null })),
      queue_ready: members.some(queueable),
    })
  }
  return out.sort((a, b) => time(b.newest.at) - time(a.newest.at) || a.key.localeCompare(b.key))
}

// ── status and touches ─────────────────────────────────────────────────────

export const SIGNAL_STATUSES = ['new', 'working', 'replied', 'dropped'] as const
export type SignalStatus = (typeof SIGNAL_STATUSES)[number]
export const TOUCH_CHANNELS = ['email', 'linkedin', 'call'] as const
export type TouchChannel = (typeof TOUCH_CHANNELS)[number]

/** A `signal_accounts` row. */
export interface SignalState {
  account_key: string
  status: SignalStatus
  email_touched_at: string | null
  linkedin_touched_at: string | null
  call_touched_at: string | null
  deal_id: string | null
}

export interface SignalRow extends SignalAccount {
  /** The key its saved state lives under (its own, or an alias that was saved before the row gained a domain). */
  state_key: string
  status: SignalStatus
  touches: Record<TouchChannel, string | null>
  deal_id: string | null
}

/**
 * Each account with its saved status and touches (new and untouched when
 * nothing is saved). State saved under a name key still applies after the
 * account gained a domain, but only when that name now belongs to exactly
 * one account: two companies sharing a name never share a status or a deal.
 */
export function applyState(accounts: readonly SignalAccount[], states: readonly SignalState[]): SignalRow[] {
  const byKey = new Map(states.map((s) => [s.account_key, s]))
  const ownKeys = new Set(accounts.map((a) => a.key))
  const carriers = new Map<string, number>()
  for (const a of accounts) for (const k of a.aliases) carriers.set(k, (carriers.get(k) ?? 0) + 1)
  const usable = (k: string) => byKey.has(k) && !ownKeys.has(k) && carriers.get(k) === 1
  return accounts.map((a) => {
    const stateKey = byKey.has(a.key) ? a.key : (a.aliases.find(usable) ?? a.key)
    const s = byKey.get(stateKey)
    return {
      ...a,
      state_key: stateKey,
      status: s?.status ?? 'new',
      touches: { email: s?.email_touched_at ?? null, linkedin: s?.linkedin_touched_at ?? null, call: s?.call_touched_at ?? null },
      deal_id: s?.deal_id ?? null,
    }
  })
}

/** Not yet touched: still new and no channel ticked (the Today queue). */
export const isUntouched = (r: Pick<SignalRow, 'status' | 'touches'>) => r.status === 'new' && !r.touches.email && !r.touches.linkedin && !r.touches.call

export interface SignalFilter {
  source?: SignalSource | 'all'
  status?: SignalStatus | 'all' | 'open'
  q?: string
}

/** `open` = new or working. `q` matches the company, domain or a contact's name. */
export function filterRows(rows: readonly SignalRow[], f: SignalFilter): SignalRow[] {
  const q = f.q?.trim().toLowerCase()
  return rows.filter((r) => {
    if (f.source && f.source !== 'all' && !r.sources.includes(f.source)) return false
    if (f.status === 'open' ? r.status !== 'new' && r.status !== 'working' : f.status && f.status !== 'all' && r.status !== f.status) return false
    if (q && !`${r.name} ${r.domain ?? ''} ${r.contacts.map((c) => c.name).join(' ')}`.toLowerCase().includes(q)) return false
    return true
  })
}

export function countByStatus(rows: readonly Pick<SignalRow, 'status'>[]): Record<SignalStatus, number> {
  const out: Record<SignalStatus, number> = { new: 0, working: 0, replied: 0, dropped: 0 }
  for (const r of rows) out[r.status]++
  return out
}

/** `GET /api/signals/inbox`. */
export interface SignalInbox {
  rows: SignalRow[]
  /** Counts over the tab being looked at (its source, or every lead account on All), whatever the status or search. */
  counts: Record<SignalStatus, number>
  /** Rows matching the filter (may exceed `rows`). */
  total: number
  /** Sources that could not be read just now. */
  failed: SignalSource[]
}

/** A short, stable hash of a string (FNV-1a, 32 bit, base 36). */
function shortHash(v: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < v.length; i++) {
    h ^= v.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/**
 * A non-routable address for a deal whose account has no known email
 * (`.invalid` never delivers). It carries the key's kind and a hash of the
 * whole key, so two accounts never share one: `d:acme.com`, `n:acme com`
 * and `r:acme_com` get three different addresses.
 */
export function placeholderEmail(key: string): string {
  const kind = /^[a-z]:/.test(key) ? key[0] : 'x'
  const slug = key.replace(/^[a-z]:/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  return `${[kind, slug, shortHash(key)].filter(Boolean).join('-')}@signal.invalid`
}

/** The campaign id every deal started from a signal sits under in the Pipeline. */
export const SIGNALS_CAMPAIGN_ID = 'signals'
