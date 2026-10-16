import { describe, expect, it } from 'vitest'
import { APOLLO_PROMPT_TEXT, ingestKeyboard, ingestPromptText, lfoCountKeyboard, parseApolloUrl } from '@/lib/import/messages'

const ID = '7db3d841-252c-4572-95ec-bc110727df8d'

describe('parseApolloUrl', () => {
  it.each([
    'https://app.apollo.io/#/people?page=1&personTitles[]=ceo',
    '  https://app.apollo.io/#/people?finderViewId=abc  ',
    'HTTPS://APP.APOLLO.IO/#/people?x=1',
  ])('accepts %s', (u) => expect(parseApolloUrl(u)).toBe(u.trim()))

  it.each([
    'http://app.apollo.io/#/people?x=1',
    'https://app.apollo.io/#/companies?x=1',
    'https://app.apollo.io/#/people',
    'https://app.apollo.io/#/people?',
    'https://evil.example/?u=https://app.apollo.io/#/people?x=1',
    'see https://app.apollo.io/#/people?x=1',
    'https://app.apollo.io/#/people?x=1 y',
    'https://app.apollo.io.evil.com/#/people?x=1',
    '',
    `https://app.apollo.io/#/people?${'a'.repeat(4000)}`,
  ])('rejects %s', (u) => expect(parseApolloUrl(u)).toBeNull())

  it('rejects non-strings', () => {
    expect(parseApolloUrl(undefined)).toBeNull()
    expect(parseApolloUrl(42)).toBeNull()
  })
})

describe('owner prompts (telegram-inbox copies)', () => {
  it('ingest prompt names Lume, the file, rows and the column', () => {
    expect(ingestPromptText({ filename: 'apify-x.csv', rowCount: 12, detectedColumn: 'email' })).toBe(
      '📥 New CSV from Lume\nFile: apify-x.csv\nRows: 12\nEmail column: email'
    )
    expect(ingestPromptText({ filename: 'f.csv', rowCount: 3, detectedColumn: null })).toContain(
      "⚠️ Couldn't confidently detect an email column"
    )
  })

  it('ingest keyboard: approve / approve_enrich / deny, or deny only without a column', () => {
    expect(ingestKeyboard(ID, 'email').inline_keyboard[0].map((b) => b.callback_data)).toEqual([
      `approve:${ID}`,
      `approve_enrich:${ID}`,
      `deny:${ID}`,
    ])
    expect(ingestKeyboard(ID, null).inline_keyboard).toEqual([[{ text: '❌ Deny', callback_data: `deny:${ID}` }]])
  })

  it('apollo prompt + lfo keyboard', () => {
    expect(APOLLO_PROMPT_TEXT.startsWith('🔗 Apollo search received.\n')).toBe(true)
    const kb = lfoCountKeyboard(ID).inline_keyboard
    expect(kb[0].map((b) => b.callback_data)).toEqual([500, 1000, 2000, 5000].map((n) => `lfo_count:${ID}:${n}`))
    expect(kb[1].map((b) => b.callback_data)).toEqual([`lfo_custom:${ID}`, `lfo_cancel:${ID}`])
  })
})
