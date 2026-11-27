import { describe, expect, it } from 'vitest'
import { checkDraft, countStats, extractNumbers, functionsIn, normalizeNumber, sharedRun, unknownNames, vendorsIn } from '@/lib/content/rules'
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
    expect(has(fails(GOOD_BODY.replace('That math works', 'At $9.50 a door that math works')), /No price and no per-door figure/)).toBe(true)
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

  it('stats: at most two, unit and door counts included; a before/after pair counts once', () => {
    expect(checkDraft(goodDraft(), ctxFor()).stats).toEqual(['1000', '3'])
    expect(countStats('Days on market went from 30+ to 19 and units leased per agent rose 280%.')).toEqual(['19', '280'])
    expect(countStats('One call at 9:57 PM led to a 153-property deal. We went from 9-to-5 to 365 days a year in 2026.')).toEqual(['153', '365'])
    // Draft 2 of the first production run: 1,600 units, 1,000 units and 17 hours is three.
    const ctx = { provided: [fact(10), fact(4), fact(1)], leadId: 10, offerId: 1, variant: null }
    const body = GOOD_BODY.replace("I didn't grow my firm from 35 to 1,000 doors by hiring faster.", 'An asset manager who owns 1,600 units in the Sun Belt told me he wants to bring management in-house.').replace('Three years in, we were at 1,000 doors, and', 'One customer runs 1,000 units in Houston and got back 17 hours per manager every week, and')
    const r = checkDraft(goodDraft({ body, fact_ids: [10, 4, 1] }), ctx)
    expect(has(r.failures, /uses 3 statistics \(1600, 1000, 17\)/)).toBe(true)
  })

  it('no price or per-door figure in the body; the first comment may carry it', () => {
    expect(has(fails(swapLast("That's why we built Kaspen. Take a free week on the doors you pick. After that it's $9.50 per door per month.")), /No price/)).toBe(true)
    expect(has(fails(GOOD_BODY.replace('another salary', 'another cost per door')), /No price/)).toBe(true)
    expect(fails(GOOD_BODY, { first_comment: 'After the free week it is $9.50 per door per month: kaspen.ai' })).toEqual([])
  })

  it('landing-page copy: more than one software name or three product functions is rejected', () => {
    expect(has(fails(GOOD_BODY.replace('another late night', 'another late night in AppFolio and Yardi')), /Don't list software names \(AppFolio, Yardi\)/)).toBe(true)
    expect(fails(GOOD_BODY.replace('another late night', 'another late night in AppFolio'))).toEqual([])
    const list = GOOD_BODY.replace('Work orders moved.', 'Leasing, maintenance, move-ins and delinquency got handled.')
    expect(has(fails(list), /Don't list the product's functions \(leasing, maintenance, move-ins, delinquency\)/)).toBe(true)
    expect(functionsIn('Leasing, maintenance and accounting.')).toEqual(['leasing', 'maintenance', 'accounting'])
    expect(vendorsIn('Rent Manager or Buildium')).toEqual(['Buildium', 'Rent Manager'])
  })

  it('sameness: tagline and "we built Kaspen" once a week, no 8-word runs from the last 14 days', () => {
    const tag = swapLast('Grow doors, not payroll. Take a free week on the doors you pick, with setup done for you, and see what changes.')
    expect(fails(tag)).toEqual([])
    expect(has(fails(tag, {}, { taglineTaken: true }), /tagline is already used/)).toBe(true)
    expect(has(fails(GOOD_BODY, {}, { builtTaken: true }), /we built Kaspen" line is already used/)).toBe(true)
    const other = 'A different post.\n\nFor a long time I thought the only way to add doors was to add people, and I was wrong.\n\nClose.'
    expect(has(fails(GOOD_BODY, {}, { recent: [{ id: 2, body: other }] }), /repeats "for a long time i thought the only" from draft #2/)).toBe(true)
    // Closing asks may repeat; so may a fact's own words.
    const sameClose = 'Unrelated opening line here.\n\nNothing in common in this middle part at all.\n\n' + GOOD_BODY.split('\n\n').slice(-1)[0]
    expect(fails(GOOD_BODY, {}, { recent: [{ id: 3, body: sameClose }] })).toEqual([])
    expect(sharedRun('He owns 1,600 units in the Sun Belt and told him his firm is considering it.\n\nx', 'A man who owns 1,600 units in the Sun Belt told him his firm is considering cutting.\n\ny', [fact(10)])).toBeNull()
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
