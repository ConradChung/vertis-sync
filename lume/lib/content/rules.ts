import type { Fact } from '@/lib/content/facts'
import type { Variant } from '@/lib/content/slots'

/**
 * The writing rules, enforced in code after generation (pure). Every failure
 * is a short, model-readable sentence: the generator feeds them back for a
 * rewrite, and stores them as the reject reason when the last try still fails.
 *
 * What code can't fully judge (voice, "sharpest line", one story) is checked
 * through proxies: first-person pronouns, the opener patterns, the stats and
 * fact-kind counts, and the proper-noun check that catches invented people,
 * customers and places.
 */

export const MIN_CHARS = 900
export const MAX_CHARS = 1300
export const HOOK_CHARS = 210
export const MAX_STATS = 2

export interface DraftOutput {
  formula: string
  body: string
  first_comment: string
  fact_ids: number[]
}

export interface RuleContext {
  /** Every fact the model was given. */
  provided: Fact[]
  leadId: number
  offerId: number
  variant: Variant | null
}

// ── numbers ────────────────────────────────────────────────────────────────

const NUM = /\d[\d,]*(?:\.\d+)?(?::\d\d)?(?:\s?[kKmM](?![a-zA-Z]))?/g
const WORDS: Record<string, number> = {
  zero: 0, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000,
  million: 1_000_000,
}
const WORD_RE = new RegExp(`\\b(${Object.keys(WORDS).join('|')})\\b`, 'gi')

export function normalizeNumber(raw: string): string {
  const t = raw.replace(/,/g, '').replace(/\s+/g, '').trim()
  if (t.includes(':')) return t
  const suffix = t.slice(-1).toLowerCase()
  const mult = suffix === 'k' ? 1000 : suffix === 'm' ? 1_000_000 : 1
  const n = Number(mult === 1 ? t : t.slice(0, -1))
  return Number.isFinite(n) ? String(Math.round(n * mult * 1000) / 1000) : t
}

export interface NumberHit {
  value: string
  index: number
  raw: string
}

/** Every number in a text: digits (with $, commas, k/m, decimals, times) and spelled-out numbers from three up. */
export function extractNumbers(text: string): NumberHit[] {
  const hits: NumberHit[] = []
  for (const m of text.matchAll(NUM)) {
    const raw = m[0].replace(/,+$/, '')
    hits.push({ value: normalizeNumber(raw), index: m.index ?? 0, raw })
  }
  for (const m of text.matchAll(WORD_RE)) hits.push({ value: String(WORDS[m[1].toLowerCase()]), index: m.index ?? 0, raw: m[0] })
  return hits.sort((a, b) => a.index - b.index)
}

export const numbersIn = (text: string) => new Set(extractNumbers(text).map((h) => h.value))

const SCALE_AFTER = /^\s*-?\s*(units?|doors?|propert(y|ies)|homes?|apartments?)\b/i
const isYear = (v: string) => /^(19|20)\d\d$/.test(v)

// ── text patterns ──────────────────────────────────────────────────────────

const BANNED: [RegExp, string][] = [
  [/game[\s-]?changer/i, 'game-changer'],
  [/deep[\s-]dive/i, 'deep dive'],
  [/\bleverag(e|es|ed|ing)\b/i, 'leverage'],
  [/\bfundamentally\b/i, 'fundamentally'],
  [/\bin today['’]s\b/i, "in today's"],
]

const SCENE_OPENER = [
  /^(it['’]?s|it\s+was|at|around|by)?\s*\d{1,2}(:\d\d)?\s*(a\.?m\.?|p\.?m\.?)\b/i,
  /^(it['’]?s|it\s+was|on|last|this|every)?\s*(a\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /^(yesterday|today|tonight|this morning|this week|last (week|night|month|year)|earlier this)\b/i,
  /^(picture this|imagine this|it was a)\b/i,
]

const PM_AUDIENCE = [
  /\b(hey|dear|attention|calling all|to all( the)?|fellow|you)\s+(property managers|pms|leasing agents)\b/i,
  /\bif you['’]?re a property manager\b/i,
  /\bif you are a property manager\b/i,
  /(^|\n)\s*property managers,/i,
  /\bto (the|every|all) property managers\b/i,
]

const JOB_LOSS = [
  /\b(jobs?|roles?|positions?)\b[^.!?\n]{0,40}\b(disappear|vanish|go away|obsolete|be replaced|be eliminated|be gone|go extinct)/i,
  /\b(replace|eliminate|get rid of|fire|lay off|cut)\s+(your\s+|their\s+|the\s+|all\s+)?(property managers|leasing agents|pms|managers|staff)\b/i,
  /\bproperty managers?\b[^.!?\n]{0,30}\b(obsolete|extinct|out of a job|out of work|disappear|replaced)/i,
]

const ASK_WORDS = /\b(comment|tag someone)\b/i
const FIRST_PERSON = /\b(I|I['’]m|I['’]ve|I['’]d|I['’]ll|my|me|we|we['’]re|our|us)\b/g

const ALLOWED_NAMES = new Set(
  [
    'i', "i'm", "i've", "i'd", "i'll", 'ai', 'kaspen', 'linkedin', 'pm', 'am', 'noi', 'us', 'frank',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  ].map((s) => s.replace(/’/g, "'"))
)
const CAPS_OK = new Set(['NOI', 'CEO', 'COO', 'CFO', 'PMC', 'PMS', 'USA', 'LLC'])

const paragraphs = (body: string) => body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
const lower = (s: string) => s.toLowerCase().replace(/’/g, "'")

/** Capitalised words that don't start a sentence and aren't in the facts: likely invented names. */
export function unknownNames(text: string, facts: Fact[]): string[] {
  const known = new Set<string>(ALLOWED_NAMES)
  for (const f of facts) for (const w of f.text.match(/[A-Za-z'’]+/g) ?? []) known.add(lower(w))
  const out = new Set<string>()
  for (const m of text.matchAll(/[A-Z][a-zA-Z'’]+/g)) {
    const i = m.index ?? 0
    if (i > 0 && /[A-Za-z0-9'’-]/.test(text[i - 1])) continue
    const before = text.slice(0, i).replace(/["'“‘(\[]+$/, '')
    if (/(^|[.!?:;]\s*|\n\s*)$/.test(before)) continue // starts a sentence or a line
    const w = lower(m[0]).replace(/'s$/, '')
    if (!known.has(w) && !known.has(lower(m[0]))) out.add(m[0])
  }
  return [...out]
}

// ── the checker ────────────────────────────────────────────────────────────

export interface RuleResult {
  ok: boolean
  failures: string[]
  charCount: number
  stats: string[]
}

export function checkDraft(d: DraftOutput, ctx: RuleContext): RuleResult {
  const f: string[] = []
  const body = d.body.replace(/\r\n/g, '\n').trim()
  const chars = body.length
  const byId = new Map(ctx.provided.map((x) => [x.id, x]))

  // Facts the draft says it used.
  const ids = [...new Set(d.fact_ids)]
  const unknownIds = ids.filter((id) => !byId.has(id))
  if (unknownIds.length) f.push(`fact_ids ${unknownIds.join(', ')} were not provided; use only the facts given.`)
  const used = ids.map((id) => byId.get(id)).filter((x): x is Fact => !!x)
  if (!ids.includes(ctx.leadId)) f.push(`The post must be built on the lead fact (id ${ctx.leadId}) and list it in fact_ids.`)
  if (!ids.includes(ctx.offerId)) f.push(`The closing ask must come from the offer fact (id ${ctx.offerId}) and list it in fact_ids.`)
  if (used.filter((x) => x.kind === 'story').length > 1) f.push('One story per post: use at most one story fact.')
  if (used.filter((x) => x.kind === 'number').length > MAX_STATS) f.push(`Use at most ${MAX_STATS} number facts.`)

  // Formula.
  if (!/^F([1-9]|1[0-6])$/.test(d.formula)) f.push('formula must be one of the codes F1 to F16 from the hook formulas.')
  if (ctx.variant === 'breakdown' && d.formula !== 'F6') f.push('This Hand-raiser week is the comment-for-the-breakdown post: use formula F6.')

  // Length and shape.
  if (chars < MIN_CHARS || chars > MAX_CHARS) f.push(`The post is ${chars} characters; it must be ${MIN_CHARS} to ${MAX_CHARS}.`)
  const paras = paragraphs(body)
  if (paras.length < 3) f.push('Put a blank line between ideas (at least 3 short paragraphs).')
  if (paras.some((p) => p.includes('\n'))) f.push('Use a blank line between lines, never a single line break.')

  // Hook.
  const first = paras[0] ?? ''
  if (first.length > HOOK_CHARS) f.push(`The opening line is ${first.length} characters; the sharpest line must come first and end inside the first ${HOOK_CHARS}.`)
  if (SCENE_OPENER.some((re) => re.test(first))) f.push('Do not open with a time, day or scene; open with the sharpest line in the post.')
  const firstWords = first.split(/\s+/).slice(0, 6)
  if (firstWords.some((w) => /^[A-Z]{3,}[!.,:?]*$/.test(w) && !CAPS_OK.has(w.replace(/[^A-Z]/g, '')))) f.push('No all-caps words in the opening line.')

  // Banned characters and words.
  if (/[—–]|--/.test(body + d.first_comment)) f.push('No em dashes or en dashes anywhere; use a period or a comma.')
  if (/(^|\s)#[A-Za-z]/.test(body)) f.push('No hashtags.')
  if (/https?:\/\/|www\.|\b[a-z0-9-]+\.(com|ai|io|co|net|org|ly)\b/i.test(body)) f.push('No links in the post body; put any link in the first comment.')
  for (const [re, word] of BANNED) if (re.test(body) || re.test(d.first_comment)) f.push(`Do not use "${word}".`)

  // Audience.
  if (PM_AUDIENCE.some((re) => re.test(body))) f.push('Write to owner-operators and asset managers; never address property managers as the audience.')
  if (JOB_LOSS.some((re) => re.test(body))) f.push('Never say property managers (or anyone) will lose their jobs.')

  // Voice.
  if ((body.match(FIRST_PERSON) ?? []).length < 2) f.push("Write in first person, in Frank's voice (I, my, we).")

  // Kaspen: at most once, as the conclusion.
  const kaspen = [...body.matchAll(/\bkaspen\b/gi)]
  if (kaspen.length > 1) f.push(`Kaspen is named ${kaspen.length} times; name it at most once.`)
  if (kaspen.length === 1 && (kaspen[0].index ?? 0) < chars / 2) f.push('Name Kaspen only near the end, as the natural conclusion, not up top.')

  // Closing ask: one, from the offer, in the last paragraph.
  const offer = byId.get(ctx.offerId)
  const last = paras[paras.length - 1] ?? ''
  if (offer) {
    const offerWords = new Set((offer.text.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP.has(w)))
    const shared = new Set((last.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => offerWords.has(w)))
    if (shared.size < 2) f.push('End with one closing ask taken from the offer fact, in the last paragraph.')
    const offerNums = [...numbersIn(offer.text)]
    const early = paras.slice(0, -1).join('\n\n')
    if (offerNums.some((n) => numbersIn(early).has(n))) f.push('Keep the offer (and its price) to the closing ask only.')
  }
  if (ctx.variant === 'breakdown') {
    if (!/\bcomment\b/i.test(last)) f.push("This week's Hand-raiser must close with: comment and I'll send the breakdown.")
  } else if (ASK_WORDS.test(body)) {
    f.push('One closing ask only, from the offer; no comment requests this week.')
  }

  // Numbers: every number in the draft must come from a fact the draft used.
  const allowed = new Set<string>()
  for (const x of used) for (const n of numbersIn(x.text)) allowed.add(n)
  const hits = extractNumbers(body)
  const bad = [...new Set(hits.filter((h) => !allowed.has(h.value)).map((h) => h.raw))]
  if (bad.length) f.push(`These numbers are not in the facts you listed: ${bad.join(', ')}. State only numbers from the facts, exactly as written.`)
  const commentBad = [...new Set(extractNumbers(d.first_comment).filter((h) => !allowed.has(h.value)).map((h) => h.raw))]
  if (commentBad.length) f.push(`The first comment has numbers not in the facts: ${commentBad.join(', ')}.`)

  // At most two statistics: numbers from number facts, not a unit/door count, not a year, not part of the offer or a story.
  const nonStat = new Set<string>()
  for (const x of used) if (x.kind !== 'number') for (const n of numbersIn(x.text)) nonStat.add(n)
  const statFacts = new Set<string>()
  for (const x of used) if (x.kind === 'number') for (const n of numbersIn(x.text)) statFacts.add(n)
  const stats = [
    ...new Set(
      hits
        .filter((h) => statFacts.has(h.value) && !nonStat.has(h.value) && !isYear(h.value))
        .filter((h) => !SCALE_AFTER.test(body.slice(h.index + h.raw.length)))
        .map((h) => h.value)
    ),
  ]
  if (stats.length > MAX_STATS) f.push(`The post uses ${stats.length} statistics (${stats.join(', ')}); use at most ${MAX_STATS}, both serving the one story.`)

  // Invented people, customers, places.
  const names = unknownNames(body + '\n\n' + d.first_comment, ctx.provided)
  if (names.length) f.push(`These names are not in the facts: ${names.join(', ')}. Do not invent people, customers, places or events.`)

  // First comment.
  if (!d.first_comment.trim()) f.push('Add a short suggested first comment.')
  if (d.first_comment.length > 400) f.push('Keep the first comment under 400 characters.')
  if (/(^|\s)#[A-Za-z]/.test(d.first_comment)) f.push('No hashtags in the first comment.')

  return { ok: f.length === 0, failures: f, charCount: chars, stats }
}

const STOP = new Set(['that', 'this', 'with', 'after', 'from', 'your', 'have', 'what', 'they', 'them', 'their', 'there', 'then', 'than', 'when', 'were', 'will'])
