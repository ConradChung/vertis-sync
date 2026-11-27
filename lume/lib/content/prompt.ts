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
4. One story per post. At most ${MAX_STATS} statistics, both serving that story. Unit or door counts that give scale don't count toward the two, but every number still has to be in the facts.
5. No hashtags. No links in the body. No em dashes or en dashes. No all-caps words in the opening line. Never use: game-changer, deep dive, leverage, fundamentally, "in today's".
6. Name Kaspen at most once, near the end, as the natural conclusion and not as a pitch.
7. End with exactly one closing ask, taken from the offer fact, in the last paragraph. Keep the offer and its price out of every earlier paragraph. Any link (kaspen.ai) goes in first_comment, never in the body.
8. Write the facts as Frank would say them: "my firm", "we", "an asset manager told me". The fact labels ("Customer result:", "Frank's story:") are not part of the text.

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
    'Slot: Proof. One number and the story of how it happened. Build the post around the lead fact. Suggested formulas: F7 (odd-precision ledger), F10 (contrarian with receipts), F4 (time-anchor confession).',
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

const factLine = (f: Fact, role: string) => `- id ${f.id} [${f.kind}, ${role}]: ${f.text} (source: ${f.source})`

export function buildUser(slot: Slot, variant: Variant | null, pick: FactPick, retry?: { previous: DraftOutput; failures: string[] }): string {
  const brief = slot === 'hand_raiser' ? VARIANT_BRIEF[variant ?? 'story'] : SLOT_BRIEF[slot]
  const lines = [
    brief,
    '',
    'Facts you may use (nothing else):',
    factLine(pick.lead, 'lead: the post is built on this'),
    ...(pick.supporting ? [factLine(pick.supporting, 'supporting number, optional')] : []),
    factLine(pick.offer, 'offer: the one closing ask'),
    ...pick.background.map((f) => factLine(f, 'background, optional')),
  ]
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
