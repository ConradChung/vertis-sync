/**
 * Reply desk macros: the one editable place for what a drafted LinkedIn
 * answer starts from. Claude picks the macro that fits what the person wrote
 * and adapts it; if Claude is unavailable or its draft breaks a rule, the
 * macro's `fallback` text is posted as is (it uses only allowed facts).
 *
 * Facts come from `content_facts` (the owner's facts bank, kinds offer /
 * number / quote); FALLBACK_FACTS is used only when that table cannot be read.
 */

export type MacroId = 'more_info' | 'pricing' | 'integrations' | 'not_now' | 'who_is_this' | 'interested'

export interface Macro {
  id: MacroId
  /** When it applies (shown to Claude). */
  when: string
  /** What the answer must do (shown to Claude). */
  guidance: string
  /** Posted as is when Claude cannot write a valid draft. First person as Frank, no links, no em dashes. */
  fallback: string
}

export const MACROS: readonly Macro[] = [
  {
    id: 'more_info',
    when: 'They ask for more info, details, a deck or a case study.',
    guidance: 'Offer the case study with one real customer result that fits them, and ask if they want it here. Only include a link if one is given in the facts.',
    fallback: 'Happy to. The short version: one operator with 350 units in Miami saved $98k in payroll. I can send the full case study here. Want it?',
  },
  {
    id: 'pricing',
    when: 'They ask what it costs, the price or the pricing model.',
    guidance: 'Give the offer plainly: a free week on the doors they pick, then $9.50 per door per month, month to month. Ask which doors they would start with.',
    fallback: 'It is $9.50 per door per month after a free week on the doors you pick, and it is month to month. Which doors would you want to start with?',
  },
  {
    id: 'integrations',
    when: 'They ask whether it works with their software (AppFolio, Buildium, Yardi, Rent Manager, Entrata, RealPage or another).',
    guidance: 'Say yes: Kaspen is added as a user in AppFolio, Buildium, Yardi, Rent Manager, Entrata, RealPage and others. Name their software if they did.',
    fallback: 'Yes. Kaspen gets added as a user in your system, whether that is AppFolio, Buildium, Yardi, Rent Manager, Entrata, RealPage or another one. What are you on?',
  },
  {
    id: 'not_now',
    when: 'They say not right now, later, next quarter, busy, or timing is off.',
    guidance: 'Thank them, no pressure, and ask when a better time to check back would be (or confirm the time they named).',
    fallback: 'Totally fair, thanks for telling me. When would be a better time for me to check back in?',
  },
  {
    id: 'who_is_this',
    when: 'They ask who this is, how you found them, or why you wrote.',
    guidance: 'One line on Frank: he grew his own firm from 35 to 1,000 doors in 3 years and built Kaspen, an AI property manager, for operators like them; he wrote because they own and run their own rentals.',
    fallback: 'I am Frank. I grew my own firm from 35 to 1,000 doors in 3 years and built Kaspen, an AI property manager, for operators who run their own rentals like you. That is why I reached out.',
  },
  {
    id: 'interested',
    when: 'They are interested or open to talk, or anything else positive that is not one of the cases above.',
    guidance: 'Answer what they said, then suggest a short call or starting the free week on the doors they pick.',
    fallback: 'Glad to hear it. The easiest way to see it is a free week on the doors you pick. Want to set up a quick call to get that going?',
  },
]

export const MACRO_IDS = MACROS.map((m) => m.id) as readonly MacroId[]
export const macroById = (id: string): Macro => MACROS.find((m) => m.id === id) ?? MACROS[MACROS.length - 1]

/** Follow-ups need a real reason to write: one of these, rotated by step. */
export const FOLLOWUP_REASONS = [
  'a customer result (one of the number facts)',
  'the free week on the doors they pick',
  'the free mystery shop offered on the site, kaspen.ai (name it; do not describe how it works, that is not in the facts)',
  "Frank's own firm growing from 35 to 1,000 doors in 3 years",
  'a different customer result (one of the number facts, not used before)',
] as const

export interface Fact {
  kind: string
  text: string
}

/** Used only when content_facts cannot be read. Exactly the owner's allowed facts. */
export const FALLBACK_FACTS: readonly Fact[] = [
  { kind: 'offer', text: 'Offer: a free week of Kaspen on the doors you pick; $9.50 per door per month after that, month to month.' },
  { kind: 'number', text: 'Customer result: $98k saved in payroll costs, 350 units, Miami.' },
  { kind: 'number', text: 'Customer result: 17 hours saved per manager every week, 1,000 units, Houston.' },
  { kind: 'number', text: 'Customer result: 3x lead-to-lease, 850 units, Vancouver.' },
  { kind: 'number', text: "Frank's own firm: grew from 35 to 1,000 doors in 3 years." },
]

/** The kinds of content_facts a draft may use (stories about people and events are left out). */
export const DRAFT_FACT_KINDS = ['offer', 'number', 'quote'] as const

/** Every number (digits, with commas/decimals) in a text, normalized: "1,000" → "1000", "$9.50" → "9.50". */
export function numbersIn(text: string): string[] {
  return (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, '').replace(/\.0+$/, '')).filter(Boolean)
}

/** The numbers a draft may use: those in the facts and in the macros (which quote the facts). */
export function allowedNumbers(facts: readonly Fact[]): Set<string> {
  const out = new Set<string>()
  for (const f of facts) for (const n of numbersIn(f.text)) out.add(n)
  for (const m of MACROS) for (const n of numbersIn(`${m.guidance} ${m.fallback}`)) out.add(n)
  return out
}

/** Posted as is when Claude cannot write a valid follow-up (one per step, each with its reason). */
export const FOLLOWUP_FALLBACKS: readonly string[] = [
  'Following up on my last note. One operator with 350 units in Miami saved $98k in payroll with Kaspen. Worth a look for your doors?',
  'One easy way to see it: a free week of Kaspen on the doors you pick, no commitment after that. Want me to set it up?',
  'If it helps, there is a free mystery shop on kaspen.ai you can try first. Happy to walk you through what it shows.',
  'For context on why I built this: my own firm grew from 35 to 1,000 doors in 3 years. Kaspen is what I wished we had. Open to a quick chat?',
  'Last one from me for now. A 1,000 unit operator in Houston saves 17 hours per manager every week with Kaspen. If the timing is ever right, I am here.',
]

export const CHECKIN_FALLBACK = 'Checking back in like you asked. Is now a better time to look at Kaspen? The free week on the doors you pick still stands.'
