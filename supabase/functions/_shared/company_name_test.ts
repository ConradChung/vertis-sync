import { assertEquals } from 'jsr:@std/assert@1'
import { acceptLlmName, applyStrict, cacheKey, cleanCompanyNameRules, cleanCompanyNames } from './company_name.ts'

Deno.test('rules: the SOP examples the deterministic layer owns', () => {
  const cases: [string, string][] = [
    ['Fortuna and Co.', 'Fortuna'],
    ['Hylton & Company', 'Hylton'],
    ['Pearce & Co', 'Pearce'],
    ['The Wealth Advisory - Marbella & UK', 'The Wealth Advisory'],
    ['Connecting Care (2000) Inc.', 'Connecting Care'],
    ['ZUKER PROPERTY LTD', 'Zuker Property'],
    ['Apt.Residential', 'Apt Residential'],
    ['MGMT Group', 'MGMT Group'],
    ['GH Property Management', 'GH Property Management'],
    ['CasaPay', 'CasaPay'],
    ['Acme Pty Ltd', 'Acme'],
    ['Women\'s Housing Company Limited', 'Women\'s Housing'],
    ['Afhadholding L.L.C', 'Afhadholding'],
    ['Westbridge GmbH', 'Westbridge'],
    ['Casa S.L.', 'Casa'],
    ['Chase Commercial', 'Chase Commercial'],
    ['Acme | Property Managers in Leeds', 'Acme'],
    ['JFM Block & Estate Management', 'JFM Block & Estate Management'],
    ['SmartClean', 'SmartClean'],
    ['GH PROPERTY LTD', 'GH Property'],
    ['MGMT PARTNERS', 'MGMT Partners'],
    ['THE STRONGMAN GROUP', 'The Strongman Group'],
    ['acme property', 'Acme Property'],
    ['Co-Pilot Co.', 'Co-Pilot'],
    ['Management Group', 'Management Group'],
    ['', ''],
  ]
  for (const [raw, want] of cases) assertEquals(cleanCompanyNameRules(raw), want, raw)
})

Deno.test('strict peels descriptive suffixes on top of the SOP', () => {
  assertEquals(applyStrict(cleanCompanyNameRules('Wildwood Management Group LLC')), 'Wildwood')
})

Deno.test('acceptLlmName: no domain, no TLD, no invented words', () => {
  assertEquals(acceptLlmName('Chard Properties', 'Chard', 'a@chardproperties.com'), 'Chard Properties')
  assertEquals(acceptLlmName('chardproperties.com', 'Chard', 'a@chardproperties.com'), null)
  assertEquals(acceptLlmName('Chard Homes', 'Chard', 'a@chardproperties.com'), null)
  assertEquals(acceptLlmName('"Zuker Property."', 'ZUKER PROPERTY LTD', 'a@zuker.com'), 'Zuker Property')
  assertEquals(acceptLlmName('Housing Services Corporation', 'Housing Services Corporation', 'a@hscorp.ca'), 'Housing Services')
  assertEquals(acceptLlmName('', 'X Ltd', 'a@x.com'), null)
  assertEquals(acceptLlmName(42, 'X Ltd', 'a@x.com'), null)
})

Deno.test('cleanCompanyNames: Haiku answers win, rejects and missing answers fall back to the rules', async () => {
  const calls: string[] = []
  const fakeFetch = ((_url: string, init: RequestInit) => {
    calls.push(String(init.body))
    const reply = [{ i: 0, name: 'Chard Properties' }, { i: 1, name: 'Made Up Brand' }]
    return Promise.resolve(new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(reply) }] }), { status: 200 }))
  }) as typeof fetch
  const written: unknown[] = []
  const llmKeys = new Set<string>()
  const out = await cleanCompanyNames(
    [
      { raw: 'Chard', email: 'a@chardproperties.com' },
      { raw: 'ZUKER PROPERTY LTD', email: 'b@zuker.com' },
      { raw: 'Hylton & Company', email: 'c@hylton.com' },
      { raw: 'Chard', email: 'd@chardproperties.com' },
    ],
    {
      anthropicKey: 'k', fetch: fakeFetch, llmKeys,
      readCache: () => Promise.resolve(new Map([[cacheKey('Hylton & Company', 'hylton.com'), 'Hylton']])),
      writeCache: rows => { written.push(...rows); return Promise.resolve() },
    },
  )
  assertEquals(out.get(cacheKey('Chard', 'chardproperties.com')), 'Chard Properties')
  assertEquals(out.get(cacheKey('ZUKER PROPERTY LTD', 'zuker.com')), 'Zuker Property')
  assertEquals(out.get(cacheKey('Hylton & Company', 'hylton.com')), 'Hylton')
  assertEquals(calls.length, 1)
  assertEquals(written.length, 1)
  assertEquals(llmKeys.size, 2)
})

Deno.test('cleanCompanyNames: no key -> rules only, nothing fetched', async () => {
  const out = await cleanCompanyNames([{ raw: 'Fortuna and Co.', email: 'a@f.com' }], {
    anthropicKey: '', fetch: () => { throw new Error('should not fetch') },
  })
  assertEquals(out.get(cacheKey('Fortuna and Co.', 'f.com')), 'Fortuna')
})

Deno.test('cleanCompanyNames: a failed Haiku call falls back to the rules', async () => {
  const out = await cleanCompanyNames([{ raw: 'ZUKER PROPERTY LTD', email: 'a@z.com' }], {
    anthropicKey: 'k', fetch: () => Promise.resolve(new Response('nope', { status: 400 })),
  })
  assertEquals(out.get(cacheKey('ZUKER PROPERTY LTD', 'z.com')), 'Zuker Property')
})
