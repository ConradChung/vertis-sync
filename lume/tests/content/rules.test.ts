import { describe, expect, it } from 'vitest'
import { checkDraft, extractNumbers, normalizeNumber, unknownNames } from '@/lib/content/rules'
import { ctxFor, fact, goodDraft, GOOD_BODY } from './fixtures'

const fails = (body: string, over = {}, ctx = {}) => checkDraft(goodDraft({ body, ...over }), ctxFor(ctx)).failures
const has = (list: string[], re: RegExp) => list.some((x) => re.test(x))
const swapLast = (last: string) => GOOD_BODY.split('\n\n').slice(0, -1).concat(last).join('\n\n')

describe('checkDraft', () => {
  it('passes a draft that follows every rule', () => {
    const r = checkDraft(goodDraft(), ctxFor())
    expect(r.failures).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.charCount).toBe(GOOD_BODY.length)
  })

  it('length: rejects under 900 and over 1,300 characters', () => {
    expect(has(fails(GOOD_BODY.split('\n\n').slice(0, 3).concat(swapLast('x').split('\n\n').slice(-1)).join('\n\n')), /characters; it must be 900 to 1300/)).toBe(true)
    expect(has(fails(GOOD_BODY.replace('So we changed', 'So we changed '.repeat(1) + 'a'.repeat(0) + 'what mattered. '.repeat(25) + 'So we changed')), /must be 900 to 1300/)).toBe(true)
  })

  it('blank lines: rejects single line breaks', () => {
    expect(has(fails(GOOD_BODY.replace('\n\nFor a long time', '\nFor a long time')), /never a single line break/)).toBe(true)
  })

  it('hook: the first line must end inside 210 characters', () => {
    const long = 'I did not grow my firm from 35 to 1,000 doors by hiring faster, and I want to explain the long and slightly boring reason why that turned out to matter more than any single hire I ever made in my whole working life so far.'
    expect(long.length).toBeGreaterThan(210)
    expect(has(fails(GOOD_BODY.replace("I didn't grow my firm from 35 to 1,000 doors by hiring faster.", long)), /sharpest line must come first/)).toBe(true)
  })

  it('hook: no timestamp or scene-setting opener', () => {
    for (const opener of ['It was 9:57 PM on a Tuesday.', 'Last Tuesday I sat with my team.', 'Yesterday a lead called.', 'Picture this: a full office.']) {
      expect(has(fails(GOOD_BODY.replace("I didn't grow my firm from 35 to 1,000 doors by hiring faster.", opener)), /Do not open with a time, day or scene/), opener).toBe(true)
    }
  })

  it('no all-caps opener', () => {
    expect(has(fails(GOOD_BODY.replace("I didn't grow", "STOP. I didn't grow")), /all-caps/)).toBe(true)
    expect(has(fails(GOOD_BODY.replace("I didn't grow my firm", "NOI matters. I didn't grow my firm")), /all-caps/)).toBe(false)
  })

  it('no em dashes, en dashes, hashtags or links in the body', () => {
    expect(has(fails(GOOD_BODY.replace('That math works', 'That math works — until')), /em dashes/)).toBe(true)
    expect(has(fails(GOOD_BODY.replace('That math works', 'That math works – until')), /em dashes/)).toBe(true)
    expect(has(fails(GOOD_BODY + ' #proptech'), /No hashtags/)).toBe(true)
    expect(has(fails(GOOD_BODY.replace('time back.', 'time back at kaspen.ai.')), /No links in the post body/)).toBe(true)
    expect(has(fails(GOOD_BODY.replace('time back.', 'time back: https://x.example')), /No links/)).toBe(true)
  })

  it('banned words', () => {
    for (const w of ['game-changer', 'deep dive', 'leverage', 'fundamentally', "in today's market"]) {
      expect(has(fails(GOOD_BODY.replace('That math works', `That ${w} math works`)), /Do not use/), w).toBe(true)
    }
  })

  it('audience: never addresses property managers, never says jobs disappear', () => {
    expect(has(fails(GOOD_BODY.replace('If you own and run your own rentals', 'If you are a property manager')), /never address property managers/)).toBe(true)
    expect(has(fails(GOOD_BODY.replace('That math works', 'Property managers, listen. That math works')), /never address property managers/)).toBe(true)
    expect(has(fails(GOOD_BODY.replace('That math works', 'Their jobs will disappear. That math works')), /lose their jobs/)).toBe(true)
    expect(has(fails(GOOD_BODY.replace('That math works', 'You can replace your property managers. That math works')), /lose their jobs/)).toBe(true)
  })

  it('voice: first person', () => {
    const third = GOOD_BODY.replace(/\bI\b|\bI'm\b|\bmy\b|\bwe\b|\bour\b|\bOur\b|\bI didn't\b/g, 'Frank')
    expect(has(fails(third.replace(/Frank'm/g, 'Frank is').replace(/Frank didn't/g, 'Frank did not')), /first person/)).toBe(true)
  })

  it('Kaspen: at most once, near the end', () => {
    expect(has(fails(GOOD_BODY.replace('That math works', 'Kaspen knows that math works')), /named 2 times/)).toBe(true)
    const early = GOOD_BODY.replace("That's why we built Kaspen. Take", "That's why we built it. Take").replace('That math works', 'Kaspen exists because that math works')
    expect(has(fails(early), /only near the end/)).toBe(true)
  })

  it('closing ask: from the offer, in the last paragraph, offer price only there', () => {
    expect(has(fails(swapLast("That's why we built Kaspen. Think about it and tell me what you find this year.")), /closing ask taken from the offer/)).toBe(true)
    expect(has(fails(GOOD_BODY.replace('That math works', 'At $9.50 a door that math works')), /offer \(and its price\) to the closing ask/)).toBe(true)
    expect(has(fails(GOOD_BODY.replace('That math works', 'Comment below. That math works')), /no comment requests/)).toBe(true)
  })

  it('breakdown week: F6 and a comment ask', () => {
    const r = fails(GOOD_BODY, {}, { variant: 'breakdown' })
    expect(has(r, /use formula F6/)).toBe(true)
    expect(has(r, /comment and I'll send the breakdown/)).toBe(true)
    const ok = swapLast("That's why we built Kaspen. Comment week and I'll send the breakdown of how the free week works on the doors you pick.")
    expect(fails(ok, { formula: 'F6' }, { variant: 'breakdown' })).toEqual([])
  })

  it('numbers: every number must appear in a fact the draft used', () => {
    expect(has(fails(GOOD_BODY.replace('another salary', 'another $60k salary')), /not in the facts you listed: 60k/)).toBe(true)
    expect(has(fails(GOOD_BODY.replace('Three years in', 'Four years in')), /not in the facts you listed: Four/)).toBe(true)
    // A number from a fact the model was given but did not list is still rejected.
    expect(has(fails(GOOD_BODY.replace('another salary', 'another 17 hours')), /not in the facts you listed: 17/)).toBe(true)
    // Formatting variants of a fact's number are fine.
    const ctx = { provided: [fact(3), fact(1)], leadId: 3, offerId: 1, variant: null }
    const body = GOOD_BODY.replace('from 35 to 1,000 doors', 'to $98,000 in payroll savings').replace('Three years in, we were at 1,000 doors', 'At 350 units')
    expect(checkDraft(goodDraft({ body, fact_ids: [3, 1] }), ctx).failures.filter((x) => /numbers/.test(x))).toEqual([])
    expect(has(fails(GOOD_BODY, { first_comment: '24/7 support: kaspen.ai' }), /first comment has numbers/)).toBe(true)
  })

  it('stats: at most two, unit counts and story numbers excluded', () => {
    const ctx = { provided: [fact(8), fact(1)], leadId: 8, offerId: 1, variant: null }
    const body = GOOD_BODY.replace("I didn't grow my firm from 35 to 1,000 doors by hiring faster.", 'Days on market went from 30+ to 19 and units leased per agent rose 280%.').replace('Three years in, we were at 1,000 doors, and', 'And')
    const r = checkDraft(goodDraft({ body, fact_ids: [8, 1] }), ctx)
    expect(has(r.failures, /uses 3 statistics/)).toBe(true)
    expect(checkDraft(goodDraft(), ctxFor()).stats).toEqual(['35', '3'])
  })

  it('facts: ids must be provided, lead and offer listed, one story, two number facts', () => {
    expect(has(fails(GOOD_BODY, { fact_ids: [7, 1, 99] }), /were not provided/)).toBe(true)
    expect(has(fails(GOOD_BODY, { fact_ids: [1] }), /built on the lead fact/)).toBe(true)
    expect(has(fails(GOOD_BODY, { fact_ids: [7] }), /offer fact/)).toBe(true)
    const ctx = { provided: [fact(9), fact(10), fact(1), fact(3), fact(4), fact(5)], leadId: 9, offerId: 1, variant: null }
    const r = checkDraft(goodDraft({ fact_ids: [9, 10, 1, 3, 4, 5] }), ctx).failures
    expect(has(r, /at most one story/)).toBe(true)
    expect(has(r, /at most 2 number facts/)).toBe(true)
  })

  it('no invented people, customers or places', () => {
    expect(has(fails(GOOD_BODY.replace('another late night', 'another late night with Maria')), /names are not in the facts: Maria/)).toBe(true)
    expect(has(fails(GOOD_BODY.replace('another late night', 'another late night in Phoenix')), /Phoenix/)).toBe(true)
    // Names from the facts are fine.
    expect(unknownNames('My team in the Sun Belt uses AppFolio.', [fact(10), fact(2)])).toEqual([])
  })

  it('formula code must be F1 to F16', () => {
    expect(has(fails(GOOD_BODY, { formula: 'hook' }), /F1 to F16/)).toBe(true)
  })
})

describe('numbers', () => {
  it('normalises money, commas, k, percent, multiples and times', () => {
    expect(normalizeNumber('$98k'.replace('$', ''))).toBe('98000')
    expect(normalizeNumber('1,000')).toBe('1000')
    expect(normalizeNumber('9:57')).toBe('9:57')
    expect(normalizeNumber('9.50')).toBe('9.5')
    expect(extractNumbers('$98k, 3x, 99%+, 30+, 2.7 days, 9:57 PM, three years, 153-property').map((h) => h.value)).toEqual([
      '98000', '3', '99', '30', '2.7', '9:57', '3', '153',
    ])
  })
})
