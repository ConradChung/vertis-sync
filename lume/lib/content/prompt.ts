import type { Fact, FactPick } from '@/lib/content/facts'
import { HOOK_CHARS, MAX_CHARS, MAX_STATS, MIN_CHARS, type DraftOutput } from '@/lib/content/rules'
import type { Slot, Variant } from '@/lib/content/slots'

/**
 * The prompt (pure). The system prompt is stable (rules + MIT reference
 * material) so it caches across the up-to-three tries of one run; the user
 * message carries the slot, the facts and, on a retry, what failed.
 */

export interface References {
  hookFormulas: string
  humanizer: string
  algorithm: string
}

export const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    formula: { type: 'string', description: 'The hook formula code used, F1 to F16.' },
    body: { type: 'string', description: 'The LinkedIn post, plain text, paragraphs separated by one blank line.' },
    first_comment: { type: 'string', description: 'A short suggested first comment Frank posts under his own post. Any link goes here.' },
    fact_ids: { type: 'array', items: { type: 'integer' }, description: 'Ids of every fact the post or first comment states.' },
  },
  required: ['formula', 'body', 'first_comment', 'fact_ids'],
  additionalProperties: false,
} as const

const RULES = `You write LinkedIn posts for Frank, the founder of Kaspen. Frank copies your draft and posts it himself.

Who reads it: owner-operators (firms that own and self-manage their rentals) and asset managers. They care about payroll, headcount and operating income (NOI). Never address property managers as the audience, and never say anyone's job will disappear.

Voice: first person, as Frank. Plain and direct, an operator talking to operators. Vary sentence length. No corporate words.

Hard rules (a draft that breaks any of them is thrown away):
1. State only what is in the facts you are given. Every number in the post must appear in a fact you list in fact_ids, written the same way. No invented anecdotes, people, customers, places, dates or events. Second-person hypotheticals ("you're running 400 doors") are fine only if they use no numbers outside the facts; safest is to keep hypotheticals number-free.
2. The sharpest line comes first and ends inside the first ${HOOK_CHARS} characters. The first paragraph is that line alone. Never open with a time, a day, or a scene.
3. ${MIN_CHARS} to ${MAX_CHARS} characters. One blank line between ideas, never a single line break.
4. One story per post, told with a beginning, a middle and an end, using only what the facts (and any story detail given with them) say. At most ${MAX_STATS} statistics in the whole post, unit and door counts included ("1,600 units" is a statistic); a before/after pair ("from 30+ to 19") counts once. Clock times and years don't count.
5. No hashtags. No links in the body. No em dashes or en dashes. No all-caps words in the opening line. Never use: game-changer, deep dive, leverage, fundamentally, "in today's".
6. Name Kaspen at most once, near the end, as the natural conclusion and not as a pitch.
7. End with exactly one closing ask, taken from the offer fact, in the last paragraph: the free week on the doors they pick (or, in a breakdown week, the comment keyword). No price and no per-door figure anywhere in the post; the price may appear only in first_comment. Any link (kaspen.ai) goes in first_comment, never in the body.
8. Write the facts as Frank would say them: "my firm", "we", "an asset manager told me". The fact labels ("Customer result:", "Frank's story:") are not part of the text.
9. The product gets one sentence at most, in Frank's own words. Never list the software it works inside (name one at most) and never list its functions (three things at most). Read-aloud check: read every sentence as Frank saying it across a table; any sentence that could sit unchanged on kaspen.ai or a landing page gets rewritten.
10. Don't sound like last week. You will be shown the other drafts from the last 14 days: don't reuse their openings, their structure or their key phrases. The tagline may appear in at most one post a week, and a "so we built Kaspen" line in at most one; you'll be told when they're already taken.

Return JSON only, matching the schema: formula, body, first_comment, fact_ids.

The reference material below (MIT licensed, linkedin-skills) is guidance on hooks and humanizing. Where it conflicts with the rules above, the rules above win: in particular never schedule or publish anything, never add hashtags, and never invent a story to fill a formula.`

export function buildSystem(refs: References): string {
  return [
    RULES,
    '<reference name="hook-formulas.md">\n' + refs.hookFormulas + '\n</reference>',
    '<reference name="humanizer-checklist.md">\n' + refs.humanizer + '\n</reference>',
    '<reference name="algorithm-heuristics.md">\n' + refs.algorithm + '\n</reference>',
  ].join('\n\n')
}

const SLOT_BRIEF: Record<Slot, string> = {
  proof:
    'Slot: Proof. One number and the story of how it happened, with a beginning (what was broken), a middle (what changed) and an end (the result), told only from the lead fact and its story detail. If the fact says little about how it happened, keep the story short rather than invent one. Suggested formulas: F7 (odd-precision ledger), F10 (contrarian with receipts), F4 (time-anchor confession).',
  owner_view:
    "Slot: Owner view. Payroll, headcount and operating income, from the owner's side of the table. Build the post around the lead fact; use the supporting number only if it serves the same story. Suggested formulas: F10 (contrarian with receipts), F3 (year-over-year pivot), F12 (permission slip).",
  hand_raiser: '',
}

const VARIANT_BRIEF: Record<Variant, string> = {
  breakdown:
    "Slot: Hand-raiser, breakdown week. A post where interested readers identify themselves: close with one ask that says comment and I'll send the breakdown, tied to the offer (what they get is how the free week works for their doors). Use formula F6 (comment-gate).",
  story:
    'Slot: Hand-raiser, story week. One story fully told (what was broken, what happened, what changed), built on the lead fact, so that the right reader sees themselves in it. Close with the offer as the one ask. Suggested formulas: F11 (emotional cold-open, no caps), F9 (curiosity gap), F4 (time-anchor confession).',
}

const factLine = (f: Fact, role: string) =>
  `- id ${f.id} [${f.kind}, ${role}]: ${f.text} (source: ${f.source})` + (f.detail?.trim() ? `\n  Story behind it (real, from the owner): ${f.detail.trim()}` : '')

export interface WeekContext {
  /** Other drafts from the last 14 days, newest first. */
  recent: { id: number; slot: string; body: string }[]
  taglineTaken: boolean
  builtTaken: boolean
}

export function buildUser(
  slot: Slot,
  variant: Variant | null,
  pick: FactPick,
  retry?: { previous: DraftOutput; failures: string[] },
  week?: WeekContext
): string {
  const brief = slot === 'hand_raiser' ? VARIANT_BRIEF[variant ?? 'story'] : SLOT_BRIEF[slot]
  const lines = [
    brief,
    '',
    'Facts you may use (nothing else):',
    factLine(pick.lead, 'lead: the post is built on this'),
    ...(pick.supporting ? [factLine(pick.supporting, 'supporting number, optional')] : []),
    factLine(pick.offer, 'offer: the one closing ask'),
    ...pick.background.map((f) =>
      factLine(f, /^product:/i.test(f.text) ? 'background, optional: one sentence in your own words at most, never its lists' : 'background, optional')
    ),
  ]
  if (week) {
    if (week.taglineTaken) lines.push('', 'The tagline is already used in a draft this week: leave it out.')
    if (week.builtTaken) lines.push('', 'A "we built Kaspen" line is already used this week: do not end that way.')
    if (week.recent.length) {
      lines.push('', 'Other drafts from the last 14 days. Do not reuse their openings, structure or key phrases:')
      for (const r of week.recent) lines.push('', `<draft id="${r.id}" slot="${r.slot}">`, r.body, '</draft>')
    }
  }
  if (retry) {
    lines.push(
      '',
      'Your previous draft was rejected. Fix every point below and return a new draft. Keep what worked.',
      ...retry.failures.map((x) => `- ${x}`),
      '',
      'Previous draft:',
      retry.previous.body
    )
  }
  return lines.join('\n')
}

/** Parse the model's JSON text into a draft, or null when it isn't the right shape. */
export function parseOutput(text: string): DraftOutput | null {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (typeof o.formula !== 'string' || typeof o.body !== 'string' || typeof o.first_comment !== 'string' || !Array.isArray(o.fact_ids)) return null
  const ids = o.fact_ids.filter((x): x is number => typeof x === 'number' && Number.isSafeInteger(x))
  return { formula: o.formula.trim(), body: o.body.trim(), first_comment: o.first_comment.trim(), fact_ids: ids }
}
