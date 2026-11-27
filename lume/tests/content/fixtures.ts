import type { Fact } from '@/lib/content/facts'
import type { DraftOutput } from '@/lib/content/rules'

/** The seed facts, as migrated (ids as in production). */
export const FACTS: Fact[] = [
  { id: 1, kind: 'offer', text: 'Offer: a free week of Kaspen on the doors you pick; $9.50 per door per month after that, month to month, with setup done for you.', source: 'kaspen.ai, read 2026-11-27', active: true },
  { id: 2, kind: 'quote', text: 'Product: Kaspen is an AI property manager that works inside the software a team already uses (AppFolio, Buildium, Yardi and others), handling leasing, maintenance, resident messages, move-ins, delinquency, accounting and compliance by call, text and email, day and night.', source: 'kaspen.ai, read 2026-11-27', active: true },
  { id: 3, kind: 'number', text: 'Customer result: $98k saved in payroll costs, 350 units, Miami.', source: 'kaspen.ai, read 2026-11-27', active: true },
  { id: 4, kind: 'number', text: 'Customer result: 17 hours saved per manager every week, 1,000 units, Houston.', source: 'kaspen.ai, read 2026-11-27', active: true },
  { id: 5, kind: 'number', text: 'Customer result: 3x lead-to-lease, 850 units, Vancouver.', source: 'kaspen.ai, read 2026-11-27', active: true },
  { id: 6, kind: 'number', text: 'Reported averages from customers in 2026: reply to a new lead in under 2 minutes; maintenance resolved in 2.7 days on average; 99%+ of after-hours calls answered on the first ring.', source: 'kaspen.ai, read 2026-11-27', active: true },
  { id: 7, kind: 'number', text: "Frank's own firm: grew from 35 to 1,000 doors in 3 years.", source: 'from his LinkedIn posts, November 2026', active: true },
  { id: 8, kind: 'number', text: "Frank's own firm: after bringing AI into leasing, days on market went from 30+ to 19 and average units leased per agent rose 280%.", source: 'from his LinkedIn posts, November 2026', active: true },
  { id: 9, kind: 'story', text: "Frank's story: one call answered at 9:57 PM led to a 153-property deal; the firm moved from Monday-to-Friday 9-to-5 to operating 365 days a year.", source: 'from his LinkedIn posts, November 2026', active: true },
  { id: 10, kind: 'story', text: "Frank's story: an asset manager who owns 1,600 units in the Sun Belt told him his firm is considering cutting out its property management company and bringing management in-house to improve NOI.", source: 'from his LinkedIn posts, November 2026', active: true },
  { id: 11, kind: 'quote', text: 'Tagline: Grow doors, not payroll.', source: 'kaspen.ai, read 2026-11-27', active: true },
]

export const fact = (id: number) => FACTS.find((f) => f.id === id)!

/** A draft that passes every rule (lead fact 7, offer 1). */
export const GOOD_BODY = [
  "I didn't grow my firm from 35 to 1,000 doors by hiring faster.",
  'For a long time I thought the only way to add doors was to add people. Every new building meant another leasing agent, another late night, another salary on the books.',
  "That math works until it doesn't. Payroll grows in a straight line. The number of doors your team can actually look after does not.",
  'So we changed what our people spent their days on. The phone got answered. Leads got a reply. Work orders moved. Our team stopped drowning in the small stuff and started running the business again.',
  "Three years in, we were at 1,000 doors, and the part I'm proudest of is not the number. It's that the same team could take on more.",
  'If you own and run your own rentals, you already know where your payroll goes. The real question is how much of it pays for work nobody on your team wanted to do.',
  "That's why we built Kaspen. Take a free week on the doors you pick, with setup done for you, and see what your team does with the time back.",
].join('\n\n')

export const goodDraft = (over: Partial<DraftOutput> = {}): DraftOutput => ({
  formula: 'F4',
  body: GOOD_BODY,
  first_comment: 'How the free week works: kaspen.ai',
  fact_ids: [7, 1],
  ...over,
})

export const ctxFor = (over: Partial<{ leadId: number; offerId: number; variant: 'breakdown' | 'story' | null }> = {}) => ({
  provided: [fact(7), fact(1), fact(2), fact(11)],
  leadId: 7,
  offerId: 1,
  variant: null as 'breakdown' | 'story' | null,
  ...over,
})
