import type { SopRules } from '@/lib/copy/sop'

/**
 * Pure SOP linter for a whole Instantly sequence (`update_sequence`): every
 * step, every enabled A/B variant, with the sequence read as one thread.
 * Client-safe (no I/O); the rules come from `lib/copy/sop.ts` (base merged
 * with the campaign's client overlay).
 *
 * Every violation names the rule, the 1-based step and the variant letter.
 * All rules block except `sequence_structure` (severity `warning`).
 *
 * - banned_phrase: a banned phrase in a subject or body. Case-insensitive,
 *   whole words (no letter or digit directly before or after; a trailing
 *   plural "s"/"es" still matches, so "solution" catches "solutions"), any
 *   whitespace between words, straight and curly apostrophes alike.
 * - no_exclamation: a "!" in a subject or body (when the SOP sets it).
 * - word_count: body words outside the step-1 range (step 1) or the
 *   follow-up range (steps 2+). A {{variable}} counts as one word; tokens
 *   without a letter or digit (dashes, emoji) don't count.
 * - proof_point_repeat: a proof point (any of its regex patterns matches)
 *   used in more than one step. A lead receives one variant per step, so two
 *   variants of the SAME step may share a proof point; a later step reusing
 *   it is flagged.
 * - proof_points_per_email: more distinct proof points in one email than
 *   `max_proof_points_per_email`.
 * - only_in_step: a phrase outside the steps it is allowed in.
 * - subject_casing / subject_length / subject_content: non-empty subjects
 *   only (an empty follow-up subject keeps the thread). {{variables}} are
 *   ignored for casing. lowercase = no capital letters; sentence = first
 *   letter capital and no later word starting with a capital; words in
 *   `allowed_capitalized` are exempt. subject_content = {{company}} /
 *   {{companyName}} with `no_company`, or a `subject.forbid` phrase.
 * - personalization_fields: more distinct personalization {{variables}}
 *   (subject + body) than allowed. {{companyName}} / {{company_name}} count
 *   as the field `company`; {{firstName}} counts only if the SOP lists it.
 * - step1_meeting_cta (step 1 only): heuristic for a yes/no question that
 *   requires a meeting — a sentence ending in "?" that contains a
 *   `meeting_words` entry (whole words) or matches a `meeting_patterns`
 *   regex (e.g. "15 minutes"). Statements ("happy to send a recording
 *   instead of a call") and questions without them ("who takes the 2am call
 *   on your side?") pass.
 * - step_forbid / step_require: `step_rules` per step: a forbidden phrase
 *   (whole words) or `forbid_patterns` regex in that step, or a required
 *   regex that no part of the email matches.
 * - signoff: the body's last non-empty line is not the step's sign-off
 *   (case-insensitive, trailing punctuation ignored).
 * - sequence_structure (warning): step count, delays (in days) or the number
 *   of step-1 variants differ from `sequence`.
 *
 * Disabled variants are skipped: Instantly never sends them.
 */

export type SopRule =
  | 'banned_phrase'
  | 'no_exclamation'
  | 'word_count'
  | 'proof_point_repeat'
  | 'proof_points_per_email'
  | 'only_in_step'
  | 'subject_casing'
  | 'subject_length'
  | 'subject_content'
  | 'personalization_fields'
  | 'step1_meeting_cta'
  | 'step_forbid'
  | 'step_require'
  | 'signoff'
  | 'sequence_structure'

export interface SopViolation {
  rule: SopRule
  /** 1-based step number. */
  step: number
  /** Variant letter (A, B, …) by position in the step; '' for sequence-wide findings. */
  variant: string
  message: string
  excerpt: string
  /** Absent = 'block'. Warnings are shown but never refuse an edit. */
  severity?: 'warning'
}

export interface LintVariant {
  subject: string
  body: string
  disabled?: boolean
}
export interface LintStep {
  delay?: number
  delay_unit?: 'minutes' | 'hours' | 'days'
  variants: LintVariant[]
}

type Finding = Omit<SopViolation, 'step' | 'variant'>

const VAR_RE = /\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/g
const BOUND_L = '(?<![\\p{L}\\p{N}_])'
const BOUND_R = '(?![\\p{L}\\p{N}_])'
const FIELD_ALIASES: Record<string, string> = { companyname: 'company', company_name: 'company' }
const COMPANY_VARS = new Set(['company', 'companyname', 'company_name'])
const UNIT_DAYS = { minutes: 1 / 1440, hours: 1 / 24, days: 1 }

export const variantLetter = (j: number) => (j < 26 ? String.fromCharCode(65 + j) : `#${j + 1}`)
export const isBlocking = (v: SopViolation) => v.severity !== 'warning'
const fieldKey = (name: string) => FIELD_ALIASES[name.toLowerCase()] ?? name.toLowerCase()

/** A phrase as a case-insensitive whole-word regex (global, unicode). */
function phraseRe(phrase: string, plural = false): RegExp {
  const words = phrase
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/['’]/g, "['’]"))
  return new RegExp(`${BOUND_L}${words.join('\\s+')}${plural ? '(?:e?s)?' : ''}${BOUND_R}`, 'giu')
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

const WORD_CHAR = /[\p{L}\p{N}]/u
const SIGNOFF_TAIL = new Set([' ', '\t', '\n', '.', ',', ';', ':', '!', '—', '–', '-'])
/** Drop leading and trailing characters for which `drop` is true: one pass from each end (no regex backtracking). */
function trimWhile(x: string, drop: (ch: string) => boolean, ends: 'both' | 'end' = 'both'): string {
  const chars = Array.from(x)
  let a = 0
  let b = chars.length
  if (ends === 'both') while (a < b && drop(chars[a])) a++
  while (b > a && drop(chars[b - 1])) b--
  return chars.slice(a, b).join('')
}
/** A word without its surrounding punctuation ("“after-hours”" → "after-hours"). */
const trimNonWord = (w: string) => trimWhile(w, (ch) => !WORD_CHAR.test(ch))

/** The match with up to 30 characters of context on each side, on one line. */
function around(text: string, start: number, end: number): string {
  const a = Math.max(0, start - 30)
  const b = Math.min(text.length, end + 30)
  return `${a > 0 ? '…' : ''}${squash(text.slice(a, b))}${b < text.length ? '…' : ''}`
}
const head = (text: string) => squash(text).slice(0, 80) + (squash(text).length > 80 ? '…' : '')

/** Words in a body: a {{variable}} is one word; tokens need a letter or digit. */
export function wordCount(text: string): number {
  return text
    .replace(VAR_RE, ' VAR ')
    .split(/\s+/)
    .filter((t) => /[\p{L}\p{N}]/u.test(t)).length
}

function firstMatch(text: string, re: RegExp): { start: number; end: number } | null {
  const m = new RegExp(re.source, re.flags.replace('g', '')).exec(text)
  return m ? { start: m.index, end: m.index + m[0].length } : null
}

/** Sentences of a body: split after . ! ? and at line breaks. */
function sentences(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function lintSubject(subject: string, rules: SopRules): Finding[] {
  const out: Finding[] = []
  const s = subject.trim()
  const words = s.split(/\s+/).filter(Boolean)
  const { min_words, max_words } = rules.subject
  if (words.length > max_words || words.length < min_words) {
    out.push({ rule: 'subject_length', message: `subject has ${words.length} words; ${min_words > 0 ? `${min_words}-${max_words}` : `at most ${max_words}`}`, excerpt: s })
  }
  if (rules.subject.no_company) {
    const v = [...s.matchAll(VAR_RE)].find((m) => COMPANY_VARS.has(m[1].toLowerCase()))
    if (v) out.push({ rule: 'subject_content', message: `subject may not contain the company name (${v[0]})`, excerpt: s })
  }
  for (const p of rules.subject.forbid) {
    if (firstMatch(s, phraseRe(p))) out.push({ rule: 'subject_content', message: `subject may not contain "${p}"`, excerpt: s })
  }

  const casing = rules.subject.casing
  if (casing === 'any') return out
  const allowed = new Set(rules.subject.allowed_capitalized.map((w) => w.toLowerCase()))
  const plain = s
    .replace(VAR_RE, ' ')
    .split(/\s+/)
    .map(trimNonWord)
    .filter(Boolean)
  const exempt = (w: string) => allowed.has(w.toLowerCase())
  if (casing === 'lowercase') {
    const bad = plain.filter((w) => /\p{Lu}/u.test(w) && !exempt(w))
    if (bad.length) out.push({ rule: 'subject_casing', message: `subject must be lowercase; capitals in ${bad.map((w) => `"${w}"`).join(', ')}`, excerpt: s })
    return out
  }
  const startsVar = /^\{\{/.test(s)
  const first = plain[0]
  if (!startsVar && first && /^\p{Ll}/u.test(first) && !exempt(first)) {
    out.push({ rule: 'subject_casing', message: 'subject must be sentence case: start with a capital letter', excerpt: s })
  }
  const later = (startsVar ? plain : plain.slice(1)).filter((w) => /^\p{Lu}/u.test(w) && !exempt(w))
  if (later.length) out.push({ rule: 'subject_casing', message: `subject must be sentence case, not Title Case: ${later.map((w) => `"${w}"`).join(', ')}`, excerpt: s })
  return out
}

function lintSignoff(body: string, want: string): Finding | null {
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean)
  const last = lines[lines.length - 1] ?? ''
  const norm = (x: string) => trimWhile(squash(x), (ch) => SIGNOFF_TAIL.has(ch), 'end').toLowerCase()
  return norm(last) === norm(want) ? null : { rule: 'signoff', message: `must end with the sign-off "${want}"`, excerpt: last }
}

function lintStructure(steps: LintStep[], rules: SopRules): SopViolation[] {
  const seq = rules.sequence
  if (!seq) return []
  const out: SopViolation[] = []
  const warn = (step: number, message: string, excerpt: string) =>
    out.push({ rule: 'sequence_structure', step, variant: '', message, excerpt, severity: 'warning' })
  if (seq.steps !== undefined && steps.length !== seq.steps) warn(steps.length, `the sequence has ${steps.length} steps; the SOP plans ${seq.steps}`, `${steps.length} steps`)
  if (seq.delays_days) {
    seq.delays_days.forEach((want, i) => {
      const st = steps[i]
      if (!st || st.delay === undefined) return
      const days = st.delay * UNIT_DAYS[st.delay_unit ?? 'days']
      if (Math.abs(days - want) > 1e-9) warn(i + 1, `waits ${+days.toFixed(2)} days; the SOP plans ${want}`, `delay ${st.delay} ${st.delay_unit ?? 'days'}`)
    })
  }
  if (seq.step1_variants !== undefined && steps[0]) {
    const n = steps[0].variants.filter((v) => !v.disabled).length
    if (n !== seq.step1_variants) warn(1, `step 1 has ${n} variant${n === 1 ? '' : 's'}; the SOP plans ${seq.step1_variants}`, `${n} variants`)
  }
  return out
}

/** Lint a whole sequence against the SOP rules. Returns [] when it is clean. */
export function lintSequence(steps: LintStep[], rules: SopRules): SopViolation[] {
  const out: SopViolation[] = []
  const banned = rules.banned_phrases.map((p) => ({ p, re: phraseRe(p, true) }))
  const personal = new Set(rules.personalization_fields.map(fieldKey))
  const meeting = [...rules.step1_cta.meeting_words.map((w) => phraseRe(w)), ...rules.step1_cta.meeting_patterns.map((p) => new RegExp(p, 'iu'))]
  const proofs = rules.proof_points.map((pp) => ({ id: pp.id, res: pp.patterns.map((p) => new RegExp(p, 'iu')) }))
  const onlyIn = Object.entries(rules.only_in_step).map(([p, s]) => ({ p, steps: s, re: phraseRe(p) }))
  /** proof point id → first step (1-based) it appears in. */
  const firstStep = new Map<string, number>()

  steps.forEach((st, i) => {
    const step = i + 1
    const range = i === 0 ? rules.word_count.step1 : rules.word_count.followup
    const stepRule = rules.step_rules[String(step)]
    const signoff = rules.signoff[String(step)]
    const usedThisStep = new Set<string>()

    st.variants.forEach((v, j) => {
      if (v.disabled) return
      const variant = variantLetter(j)
      const add = (x: Finding) => out.push({ ...x, step, variant })
      const subject = v.subject ?? ''
      const body = v.body ?? ''
      const email = `${subject}\n${body}`
      const parts = [['subject', subject], ['body', body]] as const

      for (const { p, re } of banned) {
        for (const [where, text] of parts) {
          const hit = firstMatch(text, re)
          if (hit) add({ rule: 'banned_phrase', message: `${where} uses the banned phrase "${p}"`, excerpt: around(text, hit.start, hit.end) })
        }
      }

      if (rules.no_exclamation) {
        for (const [where, text] of parts) {
          const at = text.indexOf('!')
          if (at >= 0) add({ rule: 'no_exclamation', message: `${where} has an exclamation mark`, excerpt: around(text, at, at + 1) })
        }
      }

      const words = wordCount(body)
      if (words < range.min || words > range.max) {
        add({ rule: 'word_count', message: `body has ${words} words; ${i === 0 ? 'step 1 allows' : 'follow-ups allow'} ${range.min}-${range.max}`, excerpt: head(body) })
      }

      const used: string[] = []
      for (const pp of proofs) {
        const hit = pp.res.map((re) => firstMatch(email, re)).find(Boolean)
        if (!hit) continue
        used.push(pp.id)
        usedThisStep.add(pp.id)
        const seen = firstStep.get(pp.id)
        if (seen !== undefined && seen < step) {
          add({ rule: 'proof_point_repeat', message: `proof point ${pp.id} was already used in step ${seen}; at most once per sequence`, excerpt: around(email, hit.start, hit.end) })
        }
      }
      const maxPP = rules.max_proof_points_per_email
      if (maxPP !== null && used.length > maxPP) {
        add({ rule: 'proof_points_per_email', message: `${used.length} proof points (${used.join(', ')}); at most ${maxPP} per email`, excerpt: used.join(', ') })
      }

      for (const o of onlyIn) {
        if (o.steps.includes(step)) continue
        const hit = firstMatch(email, o.re)
        if (hit) add({ rule: 'only_in_step', message: `"${o.p}" belongs only in step ${o.steps.join(', ')}`, excerpt: around(email, hit.start, hit.end) })
      }

      if (subject.trim()) for (const x of lintSubject(subject, rules)) add(x)

      const fields: string[] = []
      const shown: string[] = []
      for (const m of email.matchAll(VAR_RE)) {
        const key = fieldKey(m[1])
        if (personal.has(key) && !fields.includes(key)) {
          fields.push(key)
          shown.push(`{{${m[1]}}}`)
        }
      }
      if (fields.length > rules.max_personalization_fields_per_email) {
        add({
          rule: 'personalization_fields',
          message: `${fields.length} personalization variables (${shown.join(', ')}); at most ${rules.max_personalization_fields_per_email} per email`,
          excerpt: shown.join(' '),
        })
      }

      if (i === 0 && rules.step1_cta.forbid_yes_no_meeting) {
        for (const s of sentences(body)) {
          if (!/\?["'”’)\]]*$/.test(s)) continue
          if (meeting.some((re) => firstMatch(s, re))) {
            add({ rule: 'step1_meeting_cta', message: 'step 1 asks a yes/no question that requires a meeting; ask a qualifying question instead', excerpt: s })
          }
        }
      }

      if (stepRule) {
        for (const p of stepRule.forbid) {
          const hit = firstMatch(email, phraseRe(p, true))
          if (hit) add({ rule: 'step_forbid', message: `step ${step} may not use "${p}"`, excerpt: around(email, hit.start, hit.end) })
        }
        for (const f of stepRule.forbid_patterns) {
          const hit = firstMatch(email, new RegExp(f.pattern, 'iu'))
          if (hit) add({ rule: 'step_forbid', message: `step ${step} may not use ${f.label}`, excerpt: around(email, hit.start, hit.end) })
        }
        for (const req of stepRule.require) {
          if (!new RegExp(req.pattern, 'iu').test(email)) add({ rule: 'step_require', message: `step ${step} must include ${req.label}`, excerpt: head(body) })
        }
      }

      if (signoff) {
        const x = lintSignoff(body, signoff)
        if (x) add(x)
      }
    })
    for (const id of usedThisStep) if (!firstStep.has(id)) firstStep.set(id, step)
  })
  return [...out, ...lintStructure(steps, rules)]
}

/** One line per violation, for error messages and the editor: rule, step, variant, excerpt. */
export function formatViolation(v: SopViolation): string {
  const where = v.variant ? `Step ${v.step}, variant ${v.variant}` : `Step ${v.step}`
  return `${where} — ${v.rule}${v.severity === 'warning' ? ' (warning)' : ''}: ${v.message}${v.excerpt ? ` (“${v.excerpt}”)` : ''}`
}
