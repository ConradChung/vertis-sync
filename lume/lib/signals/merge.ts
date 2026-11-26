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
}

/** Hosts that are never a company's own domain (profiles, job boards, link shorteners). */
const SHARED_HOSTS = new Set([
  'linkedin.com', 'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'youtube.com', 'tiktok.com', 'reddit.com',
  'indeed.com', 'glassdoor.com', 'ziprecruiter.com', 'greenhouse.io', 'lever.co', 'workable.com', 'bit.ly', 'linktr.ee',
  'google.com', 'yelp.com', 'apartments.com', 'zillow.com', 'wixsite.com', 'godaddysites.com',
])

/**
 * A company's bare domain ("acme.com") from a domain or URL, lowercased, with
 * protocol, `www.`, path, port and credentials removed. Null for nothing
 * usable or for a shared host (a LinkedIn page is not the company's domain).
 */
export function domainOf(raw: string | null | undefined): string | null {
  let s = (raw ?? '').trim().toLowerCase()
  if (!s) return null
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^[^/@]*@/, '')
  s = s.split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/^www\d*\./, '').replace(/\.$/, '')
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) || s.length > 200) return null
  if (SHARED_HOSTS.has(s) || [...SHARED_HOSTS].some((h) => s.endsWith(`.${h}`))) return null
  return s
}

const LEGAL_SUFFIX = /\b(incorporated|inc|llc|l l c|llp|lp|ltd|limited|corp|corporation|co|company|plc|pllc|pc|gmbh)\b/g

/**
 * A company name reduced for matching: lowercase, accents and punctuation
 * dropped, "&" read as "and", legal suffixes (Inc, LLC, Co, …) and a leading
 * "the" removed. "Acme Property Mgmt, LLC." and "ACME PROPERTY MGMT" match.
 * Words that carry meaning ("management", "group", "realty") are kept.
 */
export function normalizeName(name: string | null | undefined): string {
  let s = (name ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  s = s.replace(/&/g, ' and ').replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
  s = s.replace(LEGAL_SUFFIX, ' ').replace(/^the\s+/, '').replace(/\s+/g, ' ').trim()
  return s
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
}

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
    const name = normalizeName(e.company)
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
    const named = members.find((m) => m.company?.trim())
    const handle = members.find((m) => m.handle?.trim())?.handle?.trim().replace(/^u\//, '')
    const contacts: SignalAccount['contacts'] = []
    for (const m of members) {
      const n = m.person?.trim()
      if (!n || contacts.length >= 3 || contacts.some((c) => c.name.toLowerCase() === n.toLowerCase())) continue
      contacts.push({ name: n, title: m.person_title?.trim() || null, linkedin: m.linkedin?.trim() || null })
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

/** Each account with its saved status and touches (new and untouched when nothing is saved). */
export function applyState(accounts: readonly SignalAccount[], states: readonly SignalState[]): SignalRow[] {
  const byKey = new Map(states.map((s) => [s.account_key, s]))
  return accounts.map((a) => {
    const stateKey = [a.key, ...a.aliases].find((k) => byKey.has(k)) ?? a.key
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
  /** Counts over every account, whatever the filter. */
  counts: Record<SignalStatus, number>
  /** Rows matching the filter (may exceed `rows`). */
  total: number
  /** Sources that could not be read just now. */
  failed: SignalSource[]
}

/** A non-routable address for a deal whose account has no known email (`.invalid` never delivers). */
export function placeholderEmail(key: string): string {
  const slug = key.replace(/^[a-z]:/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'account'
  return `${slug}@signal.invalid`
}

/** The campaign id every deal started from a signal sits under in the Pipeline. */
export const SIGNALS_CAMPAIGN_ID = 'signals'
