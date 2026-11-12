// Company names for cold-email copy: the name the way an employee would say it
// casually ("I saw what you're doing at ___"). The owner's SOP (COMPANY_NAME_SOP
// below, verbatim) is the spec.
//
// Two layers:
//   cleanCompanyNameRules — deterministic, always available. Covers the
//     mechanical rules (legal suffixes, dangling "and"/"&", parentheses,
//     dash/pipe taglines, ALL CAPS, "Apt.Residential"). Never wrecks casing on
//     a mixed-case name ("CasaPay", "MGMT Group" stay as written).
//   cleanCompanyNames — Haiku applies the full SOP in batches (the judgment
//     rules: comma taglines, generic trailing words, the email-domain sanity
//     check, acronyms inside ALL CAPS). Every answer is checked by
//     acceptLlmName and falls back to the rules output when it fails, the key
//     is missing, or the call errors. Accepted answers are cached in
//     company_name_cleanings so a preview and the push that follows agree.

import { fetchWithBackoff } from './backoff.ts'

export const COMPANY_NAME_SOP_VERSION = 2

export const COMPANY_NAME_SOP = `You are cleaning company names for use in cold email copy. Return the name the way an employee would say it casually in conversation, e.g. "I saw what you're doing at ___".

Rules:
1. Remove legal suffixes and their punctuation: Ltd, Limited, LLC, Inc, Corp, Co., & Co., and Co., and Company, PLC, Pty, GmbH, LLP, S.L., S.A.
2. Never leave a dangling word or symbol at the end ("and", "&", "-", ","). "Fortuna and Co." becomes "Fortuna", not "Fortuna and".
3. Remove anything in parentheses and anything after a dash, pipe, or comma that describes location, year, or tagline. "The Wealth Advisory - Marbella & UK" becomes "The Wealth Advisory". "Connecting Care (2000) Inc." becomes "Connecting Care".
4. Fix casing. Convert ALL CAPS to Title Case ("ZUKER PROPERTY LTD" becomes "Zuker Property"). Keep genuine acronyms and stylized brands as written ("MGMT Group", "GH Property Management", "CasaPay").
5. Fix punctuation used as a separator: "Apt.Residential" becomes "Apt Residential".
6. Keep descriptive words that are part of how the brand is said ("Chase Commercial", "My Property Host", "Ethical Estate"). Drop generic trailing words like "Services", "Group", or "Holdings" only if the name still reads as a distinct brand without them.
7. Use the email domain as a sanity check. If the company name is a single ambiguous word and the domain shows a fuller brand, use the fuller brand ("Chard" with chardproperties.com becomes "Chard Properties"). Never output the domain itself or a TLD.
8. If the name is already clean, return it unchanged. Do not invent, translate, or abbreviate.
9. If the company is blank, it is filled with the name part of the email domain in lowercase (leo@investgain.com gives "investgain"). Turn it into the brand as written: split the words and case them ("investgain" becomes "InvestGain", "chardproperties" becomes "Chard Properties"). Do not add words that are not in it.

Output only the cleaned company name. No quotes, no explanation, no trailing punctuation.`

// ---- Rules ----

// Peeled from the end, longest first, on a word boundary, repeatedly
// ("Acme Pty Ltd" needs two passes).
const LEGAL_SUFFIXES = [
  'and company', '& company', 'and co.', 'and co', '& co.', '& co',
  'incorporated', 'corporation', 'limited', 'company',
  'p.l.l.c.', 'pllc', 'l.l.c.', 'l.l.c', 'llc', 'l.l.p.', 'llp', 'l.p.', 'lp', 'plc',
  'inc.', 'inc', 'corp.', 'corp', 'ltd.', 'ltd', 'co.', 'co',
  'gmbh', 'pty.', 'pty', 'pte.', 'pte', 's.l.', 's.a.', 'n.v.', 'b.v.', 'ag',
]

// Stripped only when the owner asks for stricter personalization from the
// review screen ("Wildwood Management Group" -> "Wildwood").
export const DESCRIPTIVE_SUFFIXES = [
  'property management group', 'property management', 'properties management',
  'management group', 'management company', 'management', 'property', 'properties',
  'real estate group', 'real estate', 'realty group', 'realty',
  'holdings', 'holding', 'group', 'partners', 'partner', 'associates', 'associate',
  'enterprises', 'enterprise', 'services', 'service', 'solutions', 'solution',
  'ventures', 'venture', 'capital', 'advisors', 'advisory', 'consulting',
  'agency', 'team', 'rentals', 'rental', 'homes', 'residential', 'commercial',
  'investments', 'investment', 'development', 'developers', 'builders',
]

// A trailing conjunction or stray punctuation left by suffix stripping is the
// "Hylton & Company" -> "Hylton &" bug (SOP rule 2).
function trimEdges(s: string): string {
  let out = s.trim()
  for (let i = 0; i < 3; i++) {
    out = out
      .replace(/[\s,;:.\-–—_/\\|+]+$/g, '')
      .replace(/\s+(?:&|and|of|the|for|\+)$/i, '')
      .replace(/^[\s,;:.\-–—_/\\|]+/g, '')
      .trim()
  }
  return out
}

export function stripSuffixes(name: string, suffixes: string[]): string {
  let current = trimEdges(name)
  for (let pass = 0; pass < 5; pass++) {
    const lower = current.toLowerCase()
    let matched = false
    // trimEdges already dropped a final '.', so "S.L." is matched as "s.l".
    for (const suffix of suffixes.flatMap(x => (x.endsWith('.') ? [x, x.slice(0, -1)] : [x]))) {
      const idx = lower.lastIndexOf(suffix)
      if (idx <= 0 || idx + suffix.length !== lower.length) continue
      // Word boundary: "Incorporated" must not be shaved off "Incorporations".
      if (!/[\s,\-&.]/.test(current[idx - 1])) continue
      const candidate = trimEdges(current.slice(0, idx))
      // Never strip a name down to nothing ("Management Group" survives).
      if (candidate.length < 2) continue
      current = candidate
      matched = true
      break
    }
    if (!matched) break
  }
  return current
}

const LOWER_WORDS = new Set(['and', 'of', 'the', 'for', 'at', 'in', 'on', 'a', 'an', 'to', 'by', 'de', 'la', 'du'])

function titleWord(word: string, first: boolean): string {
  const lower = word.toLowerCase()
  if (!first && LOWER_WORDS.has(lower)) return lower
  const cased = lower.charAt(0).toUpperCase() + lower.slice(1)
  // O'Brien / D'Angelo: capitalize after a 1-2 letter prefix only ("Sam's" stays).
  return cased.replace(/^([A-Za-z]{1,2})'([a-z])/, (_m, p1, p2) => `${p1}'${p2.toUpperCase()}`)
}

/**
 * SOP rule 4. Only ALL CAPS (and all-lowercase) names are re-cased; anything
 * with mixed case is a brand as written. Inside ALL CAPS, a 2-letter word or a
 * 3-4 letter word with no vowel reads as an acronym and stays ("GH PROPERTY"
 * -> "GH Property", "MGMT"); judgment beyond that ("ROC", "BEC") is Haiku's.
 */
export function fixCasing(name: string): string {
  const letters = name.replace(/[^\p{L}]/gu, '')
  if (!letters) return name
  const allCaps = letters === letters.toUpperCase() && letters !== letters.toLowerCase()
  const allLower = letters === letters.toLowerCase() && letters !== letters.toUpperCase()
  if (!allCaps && !allLower) return name
  let first = true
  return name.split(/(\s+|[-/])/).map(part => {
    if (!/\p{L}/u.test(part)) return part
    const isFirst = first
    first = false
    if (allCaps && /^[A-Z]{2,4}$/.test(part) && (part.length === 2 || !/[AEIOUY]/.test(part)) && !LOWER_WORDS.has(part.toLowerCase())) {
      return part
    }
    return titleWord(part, isFirst)
  }).join('')
}

/** The deterministic half of the SOP; also the fallback for every Haiku answer. */
export function cleanCompanyNameRules(raw: string): string {
  const base = raw.replace(/\s+/g, ' ').trim()
  if (!base) return ''
  let out = base
    // Rule 3: anything in parentheses.
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    // Rule 5: "Apt.Residential" -> "Apt Residential" (not "J.P." or "a.b.c").
    .replace(/(\p{Ll}{2,})\.(\p{Lu}\p{Ll})/gu, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
  // Rule 3: a tagline / location after a spaced dash or a pipe.
  const cut = out.split(/\s+[-–—|]\s+|\s*\|\s*/)[0]
  if (trimEdges(cut).length >= 2) out = cut
  // Rules 1-2.
  out = stripSuffixes(out, LEGAL_SUFFIXES)
  // A comma left in front of nothing but a legal suffix is gone by now; a
  // trailing comma clause otherwise stays (Haiku judges taglines).
  out = trimEdges(out)
  if (out.length < 2) out = trimEdges(base)
  return fixCasing(out)
}

/** Review-screen "strict names": the SOP result with descriptive suffixes peeled too. */
export function applyStrict(name: string): string {
  const stricter = stripSuffixes(name, DESCRIPTIVE_SUFFIXES)
  return stricter.length >= 2 ? stricter : name
}

// ---- Blank company: fall back to the email domain ----

// Personal mailboxes say nothing about the company: no fallback for these.
export const FREE_MAIL_LABELS = new Set([
  'gmail', 'googlemail', 'yahoo', 'ymail', 'rocketmail', 'hotmail', 'outlook', 'live', 'msn', 'windowslive',
  'icloud', 'me', 'mac', 'aol', 'aim', 'protonmail', 'proton', 'pm', 'gmx', 'zoho', 'zohomail', 'yandex',
  'mail', 'email', 'inbox', 'fastmail', 'hey', 'tutanota', 'tuta', 'btinternet', 'btopenworld', 'sky',
  'virginmedia', 'talktalk', 'comcast', 'verizon', 'att', 'sbcglobal', 'bellsouth', 'cox', 'charter',
  'earthlink', 'optonline', 'shaw', 'rogers', 'sympatico', 'telus', 'videotron', 'bigpond', 'optusnet',
  'iinet', 'tpg', 'xtra', 'qq', '163', '126', 'naver', 'web', 'orange', 'wanadoo', 'free', 'libero',
])

/**
 * The company to clean when the lead has none: the email domain's name part
 * (leo@investgain.com -> "investgain"; www./mail. prefixes skipped), or ''
 * for a personal mailbox or no domain. Owner, 2026-11-12: the fallback
 * company name comes from the domain.
 */
export function companyFromDomain(email: string): string {
  const parts = emailDomain(email).split('.').filter(Boolean)
  while (parts.length > 2 && ['www', 'mail', 'email', 'mx', 'smtp'].includes(parts[0])) parts.shift()
  const label = parts.length >= 2 ? parts[0] : ''
  if (!label || FREE_MAIL_LABELS.has(label) || !/\p{L}/u.test(label)) return ''
  return label
}

/** The raw company for a lead: its own, else companyFromDomain(email). */
export const companyOrDomain = (raw: string, email: string): string => raw.trim() || companyFromDomain(email)

// ---- Guarding Haiku ----

export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@')
  return at >= 0 ? email.slice(at + 1).trim().toLowerCase() : ''
}

const squash = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '')

/**
 * SOP rules 7-8 as a hard check: no domain or TLD in the output, and every
 * word must come from the raw name or the email domain (no inventing,
 * translating or abbreviating). A rejected answer falls back to the rules.
 */
export function acceptLlmName(out: unknown, raw: string, email: string): string | null {
  if (typeof out !== 'string') return null
  const name = out.replace(/^["'\s]+|["'\s.,;:]+$/g, '').replace(/\s+/g, ' ').trim()
  if (name.length < 2 || name.length > Math.max(raw.length + 20, 40)) return null
  if (/\n/.test(name)) return null
  const domain = emailDomain(email)
  if (/\.(com|net|org|io|ai|co|uk|au|ca|de|fr|es|it|nl|ae|us|nz|ie|biz|info|app|dev)\b/i.test(name)) return null
  if (domain && name.toLowerCase() === domain) return null
  const rawSq = squash(raw)
  const label = squash(domain.split('.')[0] ?? '')
  const words = name.split(/[\s\-/&+]+/).map(squash).filter(Boolean)
  if (words.length === 0) return null
  for (const w of words) if (!rawSq.includes(w) && !(label && label.includes(w))) return null
  // Rule 1 is mechanical, so it is enforced on Haiku's answer too
  // ("Housing Services Corporation" came back with its suffix).
  return stripSuffixes(name, LEGAL_SUFFIXES)
}

// ---- Batch cleaning ----

export interface NameInput { raw: string; email: string }

export interface CleanDeps {
  anthropicKey: string
  /** Cached cleanings keyed by cacheKey(); a failed read is an empty map. */
  readCache?: (keys: { raw: string; domain: string }[]) => Promise<Map<string, string>>
  writeCache?: (rows: { raw: string; domain: string; cleaned: string }[]) => Promise<void>
  fetch?: typeof fetch
  model?: string
  batchSize?: number
  concurrency?: number
  deadline?: number
  /** Filled with the keys whose name came from Haiku (fresh or cached), not the rules. */
  llmKeys?: Set<string>
}

export const cacheKey = (raw: string, domain: string) => `${raw.trim()}\u0000${domain}`

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
export const COMPANY_NAME_MODEL = 'claude-haiku-4-5'

async function askHaiku(items: { i: number; company: string; email: string }[], deps: CleanDeps): Promise<Map<number, unknown>> {
  const doFetch = deps.fetch ?? fetch
  const res = await fetchWithBackoff(() => doFetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'x-api-key': deps.anthropicKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: deps.model ?? COMPANY_NAME_MODEL,
      max_tokens: 40 * items.length + 200,
      temperature: 0,
      system: `${COMPANY_NAME_SOP}\n\nYou will receive a JSON array of {"i", "company", "email"} items. Apply the rules to each item independently. ` +
        `Reply with only a JSON array of {"i", "name"} objects, one per input item, where "name" is the cleaned company name.`,
      messages: [{ role: 'user', content: JSON.stringify(items) }],
    }),
    signal: AbortSignal.timeout(60_000),
  }), { waits: [2000, 5000, 10000], deadline: deps.deadline })
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json() as { content?: { type: string; text?: string }[] }
  const text = (data.content ?? []).map(c => c.text ?? '').join('')
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end < start) throw new Error('Anthropic reply had no JSON array')
  const parsed = JSON.parse(text.slice(start, end + 1)) as { i?: unknown; name?: unknown }[]
  const out = new Map<number, unknown>()
  for (const p of parsed) if (typeof p?.i === 'number') out.set(p.i, p.name)
  return out
}

/**
 * Cleaned names keyed by cacheKey(raw, emailDomain(email)). Always returns an
 * entry for every non-blank input: Haiku's answer when it passes
 * acceptLlmName, else cleanCompanyNameRules. Never throws.
 */
export async function cleanCompanyNames(inputs: NameInput[], deps: CleanDeps): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const todo = new Map<string, NameInput>()
  for (const inp of inputs) {
    const raw = inp.raw.trim()
    if (!raw) continue
    const key = cacheKey(raw, emailDomain(inp.email))
    if (!out.has(key)) out.set(key, cleanCompanyNameRules(raw))
    if (!todo.has(key)) todo.set(key, { raw, email: inp.email })
  }
  if (!deps.anthropicKey || todo.size === 0) return out

  if (deps.readCache) {
    try {
      const cached = await deps.readCache([...todo.entries()].map(([, v]) => ({ raw: v.raw, domain: emailDomain(v.email) })))
      for (const [k, v] of cached) if (todo.has(k)) { out.set(k, stripSuffixes(v, LEGAL_SUFFIXES)); todo.delete(k); deps.llmKeys?.add(k) }
    } catch (err) {
      console.error('[company_name] cache read failed:', err instanceof Error ? err.message : err)
    }
  }

  const entries = [...todo.entries()]
  const size = deps.batchSize ?? 50
  const batches: [string, NameInput][][] = []
  for (let i = 0; i < entries.length; i += size) batches.push(entries.slice(i, i + size))
  const fresh: { raw: string; domain: string; cleaned: string }[] = []

  let next = 0
  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next++]
      if (deps.deadline !== undefined && Date.now() > deps.deadline) return
      try {
        const answers = await askHaiku(batch.map(([, v], i) => ({ i, company: v.raw, email: v.email })), deps)
        batch.forEach(([key, v], i) => {
          const name = acceptLlmName(answers.get(i), v.raw, v.email)
          if (!name) return
          out.set(key, name)
          deps.llmKeys?.add(key)
          fresh.push({ raw: v.raw, domain: emailDomain(v.email), cleaned: name })
        })
      } catch (err) {
        console.error('[company_name] Haiku batch failed, using the rules:', err instanceof Error ? err.message : err)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(deps.concurrency ?? 6, batches.length) }, worker))

  if (deps.writeCache && fresh.length) {
    try {
      await deps.writeCache(fresh)
    } catch (err) {
      console.error('[company_name] cache write failed:', err instanceof Error ? err.message : err)
    }
  }
  return out
}

/** REST-backed cache deps over company_name_cleanings (service role). */
export function restCache(supabaseUrl: string, serviceKey: string): Pick<CleanDeps, 'readCache' | 'writeCache'> {
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' }
  return {
    async readCache(keys) {
      const map = new Map<string, string>()
      for (let i = 0; i < keys.length; i += 200) {
        const part = keys.slice(i, i + 200)
        const res = await fetch(`${supabaseUrl}/rest/v1/rpc/company_name_cleanings_lookup`, {
          method: 'POST', headers,
          body: JSON.stringify({ p_keys: part, p_version: COMPANY_NAME_SOP_VERSION }),
        })
        if (!res.ok) throw new Error(`cache lookup ${res.status}: ${(await res.text()).slice(0, 200)}`)
        for (const r of (await res.json()) as { raw: string; domain: string; cleaned: string }[]) map.set(cacheKey(r.raw, r.domain), r.cleaned)
      }
      return map
    },
    async writeCache(rows) {
      for (let i = 0; i < rows.length; i += 500) {
        const res = await fetch(`${supabaseUrl}/rest/v1/company_name_cleanings?on_conflict=raw,domain,sop_version`, {
          method: 'POST',
          headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(rows.slice(i, i + 500).map(r => ({ ...r, sop_version: COMPANY_NAME_SOP_VERSION }))),
        })
        if (!res.ok) throw new Error(`cache write ${res.status}: ${(await res.text()).slice(0, 200)}`)
      }
    },
  }
}
