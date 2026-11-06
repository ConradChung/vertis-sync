/**
 * Influencer candidates (pure): a list of names (an attached xlsx / csv) staged
 * for the LinkedIn lookup. Column mapping, name normalisation for the
 * duplicate check, and the lookup estimate the approval shows. The lookup
 * itself runs in the influencer-lookup edge function after the owner approves.
 */

export const CANDIDATE_FIELDS = ['name', 'title', 'company', 'category', 'notes', 'source_context'] as const
export type CandidateField = (typeof CANDIDATE_FIELDS)[number]
export type CandidateMapping = Partial<Record<CandidateField, string>>

/** Header aliases (lowercase, letters and digits only), most specific first. */
const ALIASES: Record<CandidateField, string[]> = {
  name: ['name', 'fullname', 'influencer', 'person', 'personname', 'contactname'],
  title: ['titlerole', 'title', 'role', 'jobtitle', 'position', 'headline'],
  company: ['companyorganization', 'companyorganisation', 'company', 'organization', 'organisation', 'org', 'employer'],
  category: ['category', 'type', 'segment', 'group'],
  notes: ['focusnotes', 'notes', 'focus', 'description', 'bio', 'about'],
  source_context: ['sourcecontext', 'source', 'context', 'foundvia', 'where'],
}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '')

export class UnknownCandidateColumnError extends Error {
  constructor(readonly detail: string) {
    super(detail)
    this.name = 'UnknownCandidateColumnError'
  }
}

/** Field -> header: overrides (field -> header name) first, then aliases. A name column is required. */
export function candidateColumnMapping(header: readonly string[], overrides: CandidateMapping = {}): { mapping: CandidateMapping; unmapped: string[] } {
  const used = new Set<string>()
  const mapping: CandidateMapping = {}
  for (const [field, h] of Object.entries(overrides) as [CandidateField, string][]) {
    if (!h) continue
    const found = header.find((x) => x === h) ?? header.find((x) => x.toLowerCase() === h.trim().toLowerCase())
    if (!found) throw new UnknownCandidateColumnError(`unknown_column: ${field} → "${h}"`)
    mapping[field] = found
    used.add(found)
  }
  for (const field of CANDIDATE_FIELDS) {
    if (mapping[field]) continue
    for (const alias of ALIASES[field]) {
      const hit = header.find((x) => !used.has(x) && norm(x) === alias)
      if (hit) {
        mapping[field] = hit
        used.add(hit)
        break
      }
    }
  }
  if (!mapping.name) throw new UnknownCandidateColumnError('no_name_column: map the column with the person\'s name (columns: { name: "<header>" })')
  return { mapping, unmapped: header.filter((x) => !used.has(x)) }
}

const HONORIFICS = new Set(['dr', 'mr', 'mrs', 'ms', 'miss', 'prof', 'sir', 'dame'])

/** "Dr. José Álvarez (Pepe), CPM" -> "jose alvarez": for the duplicate check only. */
export function normalizePersonName(raw: string): string {
  const base = raw.split(',')[0].replace(/\([^)]*\)/g, ' ')
  const words = base
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
  while (words.length > 1 && HONORIFICS.has(words[0])) words.shift()
  return words.join(' ')
}

export interface PlannedCandidate {
  row_index: number
  name: string
  title: string | null
  company: string | null
  category: string | null
  notes: string | null
  source_context: string | null
  status: 'pending_lookup' | 'duplicate'
  /** Always null at import: a hard duplicate needs the same linkedin_url (set by the lookup / approval). */
  influencer_id: string | null
  /** An existing influencer with the same name: a note for the review, never a block (a different person may share it). */
  possible_duplicate_of: string | null
}

const LIMITS: Record<CandidateField, number> = { name: 200, title: 500, company: 500, category: 500, notes: 2000, source_context: 2000 }

/**
 * One staged row per named person (rows without a name are skipped and
 * counted). An existing influencer with the same normalised name is only
 * noted (possible_duplicate_of): the row is still looked up, since a name
 * alone can be a different person; the lookup marks a hard duplicate when the
 * LinkedIn URL matches. An earlier row of this list with the same name AND
 * company is a 'duplicate' (not looked up twice).
 */
export function planCandidates(
  header: readonly string[],
  rows: readonly (readonly string[])[],
  mapping: CandidateMapping,
  existing: readonly { id: string; name: string }[]
): { rows: PlannedCandidate[]; skipped_no_name: number; to_look_up: number; possible_duplicates: number } {
  const col = (f: CandidateField) => (mapping[f] ? header.indexOf(mapping[f]!) : -1)
  const idx = Object.fromEntries(CANDIDATE_FIELDS.map((f) => [f, col(f)])) as Record<CandidateField, number>
  const known = new Map(existing.map((e) => [normalizePersonName(e.name), e.id]))
  const seen = new Set<string>()
  const out: PlannedCandidate[] = []
  let skipped = 0
  rows.forEach((r, i) => {
    const get = (f: CandidateField) => {
      const v = idx[f] >= 0 ? (r[idx[f]] ?? '').trim() : ''
      return v ? v.slice(0, LIMITS[f]) : null
    }
    const name = get('name')
    const key = name ? normalizePersonName(name) : ''
    if (!name || !key) {
      skipped++
      return
    }
    const existingId = known.get(key) ?? null
    const repeatKey = `${key}|${normalizePersonName(get('company') ?? '')}`
    const repeat = seen.has(repeatKey)
    seen.add(repeatKey)
    out.push({
      row_index: i,
      name,
      title: get('title'),
      company: get('company'),
      category: get('category'),
      notes: get('notes'),
      source_context: get('source_context'),
      status: repeat ? 'duplicate' : 'pending_lookup',
      influencer_id: null,
      possible_duplicate_of: repeat ? null : existingId,
    })
  })
  return {
    rows: out,
    skipped_no_name: skipped,
    to_look_up: out.filter((r) => r.status === 'pending_lookup').length,
    possible_duplicates: out.filter((r) => r.possible_duplicate_of).length,
  }
}

/** One Perplexity Sonar call (~$0.006) + a small Haiku parse per person (mirrors supabase/functions/_shared/influencer/lookup.ts). */
export const LOOKUP_USD_PER_PERSON = 0.0065
export const LOOKUP_CAP_LIMIT_USD = 50

const ceilCents = (n: number) => Math.ceil(n * 100 - 1e-9) / 100

/** What the approval shows: people x the per-person cost, and a default hard cap with 25 % headroom ($0.10 to $50). */
export function estimateLookup(people: number): { people: number; usd: number; default_cap_usd: number } {
  const usd = Math.round(people * LOOKUP_USD_PER_PERSON * 100) / 100
  const cap = Math.min(LOOKUP_CAP_LIMIT_USD, Math.max(0.1, ceilCents(people * LOOKUP_USD_PER_PERSON * 1.25)))
  return { people, usd, default_cap_usd: cap }
}

// ---------------------------------------------------------------------------
// Approval

export interface ReviewCandidate {
  id: string
  name: string
  title: string | null
  company: string | null
  category: string | null
  status: string
  linkedin_url: string | null
}

/** `https://linkedin.com/in/X/` and `https://www.linkedin.com/in/x` are the same profile. */
export const profileKey = (u: string) => u.trim().toLowerCase().replace(/^https?:\/\/(?:[a-z]{2,3}\.|www\.)?/, '').replace(/\/+$/, '')

/** "Jennifer Ruelens (PM Jen)" → "jennifer-ruelens" (same rule as schemas.ts slugFromName). */
function slugBase(name: string): string {
  return (
    name
      .replace(/\([^)]*\)/g, ' ')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 74)
      .replace(/-+$/g, '') || 'influencer'
  )
}

export interface ApprovalPlan {
  /** New influencers rows (inactive: nothing runs until the owner picks them). */
  create: { candidate_id: string; influencer: { name: string; slug: string; linkedin_url: string; notes: string | null; active: false } }[]
  /** The profile already is an influencer: link the candidate to it. */
  link: { candidate_id: string; influencer_id: string }[]
  skipped: { candidate_id: string; reason: string }[]
}

/**
 * What approving these candidates does. Only 'found' candidates with a URL
 * are approved; a URL an influencer already has links to it; two candidates
 * with the same profile in one approval keep the first. Slugs are unique
 * against existing influencers and each other (-2, -3, ...).
 */
export function planApproval(cands: readonly ReviewCandidate[], existing: readonly { id: string; slug: string; linkedin_url: string }[]): ApprovalPlan {
  const byUrl = new Map(existing.map((e) => [profileKey(e.linkedin_url), e.id]))
  const slugs = new Set(existing.map((e) => e.slug))
  const plan: ApprovalPlan = { create: [], link: [], skipped: [] }
  const taken = new Set<string>()
  for (const c of cands) {
    if (c.status !== 'found' || !c.linkedin_url) {
      plan.skipped.push({ candidate_id: c.id, reason: c.status === 'found' ? 'no LinkedIn URL found' : `no LinkedIn URL found (status ${c.status})` })
      continue
    }
    const key = profileKey(c.linkedin_url)
    const known = byUrl.get(key)
    if (known) {
      plan.link.push({ candidate_id: c.id, influencer_id: known })
      continue
    }
    if (taken.has(key)) {
      plan.skipped.push({ candidate_id: c.id, reason: 'same profile as another candidate in this approval' })
      continue
    }
    taken.add(key)
    const base = slugBase(c.name)
    let slug = base
    for (let n = 2; slugs.has(slug); n++) slug = `${base}-${n}`
    slugs.add(slug)
    const notes = [c.title, c.company, c.category].filter(Boolean).join(' · ').slice(0, 1000) || null
    plan.create.push({ candidate_id: c.id, influencer: { name: c.name.slice(0, 200), slug, linkedin_url: c.linkedin_url, notes, active: false } })
  }
  return plan
}
