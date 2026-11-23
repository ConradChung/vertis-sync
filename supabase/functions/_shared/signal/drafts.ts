// GTM-14: DM / connection-note drafts from fixed templates. Pure, no LLM.
//
// The only statements about Frank come from frank-facts.json `facts[]`, in
// order (operator fact first). Kaspen's product line is a template constant
// (about the product, not Frank) and is only used when a fact names Kaspen.
// `unconfirmed_do_not_use` is never read into a draft; buildDrafts throws if
// a template output mentions a guarded term that the facts don't contain.
import { ptDate } from './caps.ts'

export interface Facts {
  sender_first_name?: string
  facts: string[]
  unconfirmed_do_not_use?: string[]
  linkedin_premium?: boolean
  connection_note_max_chars?: number
}

export interface Drafts {
  opening: string
  dm: string
  connection_note: string
  followup_dm: string
  no_note_followup: string
}

export const OPENING_TODAY = 'Saw you in our thread earlier.'
export const OPENING_EARLIER = 'Saw your comment on my post.'
export const REACTOR_PLACEHOLDER = '{opening line}'
export const KASPEN_PITCH = 'where we use AI to help PM companies with leasing, accounting, compliance and operations'
export const SCALING_TAIL = 'so I always love connecting with fellow operators who are scaling'
export const DEMO_ASK = 'Would you like to see a quick demo?'

/** Terms a draft may never contain unless a fact does (unconfirmed claims about Frank). */
export const GUARDED = [/ucla/i, /google/i, /berkeley/i, /graduat/i]

/** Commenters: today (PT) → "in our thread earlier"; otherwise "your comment on my post". */
export function commenterOpening(commentedAt: string | null, now: Date): string {
  if (!commentedAt || !Number.isFinite(Date.parse(commentedAt))) return OPENING_EARLIER
  return ptDate(new Date(commentedAt)) === ptDate(now) ? OPENING_TODAY : OPENING_EARLIER
}

export function noteLimit(f: Facts): number {
  const set = Number(f.connection_note_max_chars)
  const n = Number.isFinite(set) && set > 0 ? Math.floor(set) : (f.linkedin_premium ? 300 : 200)
  return f.linkedin_premium ? n : Math.min(n, 200)
}

const strip = (s: string) => s.trim().replace(/[.!\s]+$/, '')

/** "I'm a co-founder of Kaspen" → "I'm also a co-founder of Kaspen" (second and later facts). */
function also(s: string): string {
  if (/\balso\b/i.test(s)) return s
  const m = /^(I'm|I am|I)\s+(.*)$/.exec(s)
  if (!m) return s
  return m[1] === 'I' ? `I also ${m[2]}` : `${m[1]} also ${m[2]}`
}

/** The fact sentences, in order: the first with the operator tail, Kaspen facts with the product line. */
export function factSentences(facts: string[]): string[] {
  return facts.map((raw, i) => {
    let s = strip(raw)
    if (!s) return ''
    if (i > 0) s = also(s)
    if (i === 0) s = `${s}, ${SCALING_TAIL}`
    if (/\bkaspen\b/i.test(s) && i > 0) s = `${s}, ${KASPEN_PITCH}`
    return `${s}.`
  }).filter(Boolean)
}

/** Cut to `max` chars on a word boundary (no trailing punctuation fragments). */
export function truncateWords(s: string, max: number): string {
  if (s.length <= max) return s
  const cut = s.slice(0, max + 1)
  const sp = cut.lastIndexOf(' ')
  const out = (sp > 0 ? cut.slice(0, sp) : s.slice(0, max)).replace(/[,;:\s-]+$/, '')
  return out.length <= max ? out : out.slice(0, max)
}

export interface DraftInput {
  first_name: string | null
  company_name: string | null
  opening: string
}

const FIRST = '\u0000FIRST\u0000'
const COMPANY = '\u0000COMPANY\u0000'

function guard(text: string, facts: Facts) {
  const allowed = facts.facts.join(' ')
  for (const re of GUARDED) {
    if (re.test(text) && !re.test(allowed)) throw new Error(`draft guard: "${re.source}" is not in facts[]`)
  }
  for (const u of facts.unconfirmed_do_not_use ?? []) {
    const t = u.trim()
    if (t.length >= 6 && text.toLowerCase().includes(t.toLowerCase()) && !allowed.toLowerCase().includes(t.toLowerCase())) {
      throw new Error('draft guard: an unconfirmed claim reached a draft')
    }
  }
}

export function buildDrafts(p: DraftInput, facts: Facts): Drafts {
  const sentences = factSentences(Array.isArray(facts.facts) ? facts.facts : [])
  const operator = sentences[0] ?? ''
  const rest = sentences.slice(1).join(' ')
  const opening = p.opening.trim()

  // Templates with lead fields as placeholders, so the guard sees only our words.
  const ask = `How is business at ${COMPANY}?`
  const dmT = [`Hey ${FIRST}, ${opening}`, ask, operator, rest, DEMO_ASK].filter(Boolean).join(' ')
  const followT = [`Thanks for connecting, ${FIRST}!`, ask, rest, DEMO_ASK].filter(Boolean).join(' ')
  const noNoteT = [`Hey ${FIRST}, thanks for connecting. ${opening}`, ask, operator, rest, DEMO_ASK].filter(Boolean).join(' ')
  const opFact = strip(facts.facts?.[0] ?? '')
  const noteLong = [`Hi ${FIRST}, ${opening}`, opFact ? `${opFact}.` : '', 'Would love to connect with a fellow operator.'].filter(Boolean).join(' ')
  const noteShort = `Hi ${FIRST}, ${opening} Would love to connect with a fellow operator.`
  for (const t of [dmT, followT, noNoteT, noteLong]) guard(t, facts)

  const first = (p.first_name ?? '').trim() || 'there'
  const company = (p.company_name ?? '').trim() || 'your company'
  const fill = (t: string) => t.split(FIRST).join(first).split(COMPANY).join(company)

  const limit = noteLimit(facts)
  let note = fill(noteLong)
  if (note.length > limit) note = fill(noteShort)
  if (note.length > limit) note = truncateWords(note, limit)

  return { opening, dm: fill(dmT), connection_note: note, followup_dm: fill(followT), no_note_followup: fill(noNoteT) }
}
