// GTM-14: a door count from the crawl worker's free-text doors_hint. Pure.
// Only a real number tied to units / doors / homes / apartments / properties
// counts; ranges take the lower bound; anything else is null.

const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)`
const SCALE = String.raw`(?:\s*(k|m|thousand|million)\b)?`
const RANGE = String.raw`(?:\s*\+)?(?:\s*(?:-|–|—|to)\s*\d[\d,.]*\s*(?:k|m|thousand|million)?)?(?:\s*\+)?`
const KEYWORD = String.raw`(?:units?|doors?|homes?|apartments?|propert(?:y|ies)|residences?)\b`
// up to two words between the number and the keyword ("5,000 rental units", "300 single-family homes")
const GAP = String.raw`(?:\s+(?!(?:across|in|of|and|plus|cities|states|countries|years?|employees|staff)\b)[a-z][a-z-]*){0,2}\s+`

const RE = new RegExp(`${NUM}${SCALE}${RANGE}${GAP}${KEYWORD}`, 'gi')

export function parseDoorsHint(hint: string | null | undefined): number | null {
  if (!hint) return null
  const s = hint.toLowerCase()
  RE.lastIndex = 0
  const m = RE.exec(s)
  if (!m) return null
  let n = Number(m[1].replace(/,/g, ''))
  const scale = m[2]
  if (scale === 'k' || scale === 'thousand') n *= 1_000
  else if (scale === 'm' || scale === 'million') n *= 1_000_000
  n = Math.floor(n)
  return Number.isFinite(n) && n > 0 && n < 100_000_000 ? n : null
}
