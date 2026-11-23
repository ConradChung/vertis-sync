// Run: deno test _shared/signal/drafts_test.ts
import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@1'
import { buildDrafts, commenterOpening, noteLimit, OPENING_EARLIER, OPENING_TODAY, truncateWords } from './drafts.ts'
import realFacts from './frank-facts.json' with { type: 'json' }
import { FACTS } from './testkit.ts'

const NOW = new Date('2026-11-23T20:00:00Z')
const GUARDED = /ucla|google|berkeley|graduat/i

Deno.test('opening: same PT day → thread earlier; otherwise comment on my post', () => {
  assertEquals(commenterOpening('2026-11-23T09:00:00Z', NOW), OPENING_TODAY) // 01:00 PT same day
  assertEquals(commenterOpening('2026-11-23T07:00:00Z', NOW), OPENING_EARLIER) // 23:00 PT the day before
  assertEquals(commenterOpening(null, NOW), OPENING_EARLIER)
})

Deno.test('drafts from the real facts file: operator fact first, sample wording', () => {
  const d = buildDrafts({ first_name: 'Dana', company_name: 'Whitfield PM', opening: OPENING_TODAY }, realFacts)
  assertEquals(d.dm,
    'Hey Dana, Saw you in our thread earlier. How is business at Whitfield PM? I run a property management company of about 1,000 units ' +
      'in Vancouver, so I always love connecting with fellow operators who are scaling. I\'m also a co-founder of Kaspen, where we use AI ' +
      'to help PM companies with leasing, accounting, compliance and operations. Would you like to see a quick demo?')
  assert(d.connection_note.length <= 200)
  assert(d.followup_dm.startsWith('Thanks for connecting, Dana!'))
  assert(d.no_note_followup.includes('1,000 units'))
  assertEquals(d.opening, OPENING_TODAY)
})

Deno.test('fact guard: no draft mentions UCLA / Google / Berkeley / graduat* unless facts[] does', () => {
  for (const f of [realFacts, FACTS]) {
    const factsText = f.facts.join(' ')
    const d = buildDrafts({ first_name: 'Ana', company_name: 'Acme Rentals', opening: OPENING_EARLIER }, f)
    for (const text of Object.values(d)) {
      if (!GUARDED.test(factsText)) assert(!GUARDED.test(text), `guarded term in draft: ${text}`)
    }
  }
  // A lead's own company may contain a guarded word: that's their fact, not Frank's.
  const d = buildDrafts({ first_name: 'Ana', company_name: 'Berkeley Property Group', opening: OPENING_EARLIER }, FACTS)
  assert(d.dm.includes('Berkeley Property Group'))
  // A fact with a guarded term not in facts[] can't sneak in through the template.
  assertThrows(() => buildDrafts({ first_name: 'A', company_name: 'B', opening: 'Fellow UCLA grad here.' }, FACTS))
  // When the fact IS in facts[], it may be used.
  const withFact = { ...FACTS, facts: [...FACTS.facts, "I'm graduating UCLA this Dec."] }
  assert(buildDrafts({ first_name: 'A', company_name: 'B', opening: OPENING_EARLIER }, withFact).dm.includes('UCLA'))
})

Deno.test('connection note: ≤ 200 on free accounts (shorter variant, then word-boundary cut)', () => {
  assertEquals(noteLimit({ facts: [], linkedin_premium: false, connection_note_max_chars: 300 }), 200)
  assertEquals(noteLimit({ facts: [], linkedin_premium: true, connection_note_max_chars: 300 }), 300)
  const long = 'Bartholomew-Maximilian'
  const d = buildDrafts({ first_name: long, company_name: 'X', opening: OPENING_TODAY }, FACTS)
  assert(d.connection_note.length <= 200)
  const tiny = buildDrafts({ first_name: 'Al', company_name: 'X', opening: OPENING_EARLIER }, { ...FACTS, connection_note_max_chars: 60 })
  assert(tiny.connection_note.length <= 60, tiny.connection_note)
  assert(!tiny.connection_note.endsWith(' '))
  assertEquals(truncateWords('one two three four', 9), 'one two')
})
