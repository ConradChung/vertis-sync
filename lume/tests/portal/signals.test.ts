import { describe, expect, it } from 'vitest'
import { portalSeesSignals, portalSignalAccounts, signalsClient } from '@/lib/portal/signals'
import type { SignalRow } from '@/lib/signals/merge'

const row = (key: string, o: Partial<SignalRow> = {}): SignalRow => ({
  key, aliases: [], name: key, domain: key.startsWith('d:') ? key.slice(2) : null, sources: ['influencer'], count: 1,
  newest: { source: 'influencer', label: 'Reacted to Frank', at: '2026-11-20T00:00:00Z', url: null }, phone: null, contacts: [], events: [], latest: {},
  state_key: key, status: 'new', touches: { email: null, linkedin: null, call: null }, deal_id: null, ...o,
})

describe('who sees signals in the portal', () => {
  it('only the signals client (Kaspen unless LUME_SIGNALS_CLIENT says otherwise), compared without case', () => {
    expect(signalsClient({})).toBe('Kaspen')
    expect(portalSeesSignals('Kaspen', {})).toBe(true)
    expect(portalSeesSignals(' kaspen ', {})).toBe(true)
    for (const other of ['Muse', 'Kaspen Two', '', null, undefined]) expect(portalSeesSignals(other, {}), String(other)).toBe(false)
    expect(portalSeesSignals('Muse', { LUME_SIGNALS_CLIENT: 'Muse' })).toBe(true)
    expect(portalSeesSignals('Kaspen', { LUME_SIGNALS_CLIENT: 'Muse' })).toBe(false)
    expect(signalsClient({ LUME_SIGNALS_CLIENT: '  ' })).toBe('Kaspen')
  })
})

describe('portalSignalAccounts (today’s accounts to call)', () => {
  it('lists open companies with no call ticked, the ones with a phone first, keeping newest-first inside each half', () => {
    const { accounts, more } = portalSignalAccounts([
      row('d:a.com'),
      row('d:b.com', { phone: '555-0001' }),
      row('d:c.com', { status: 'working' }),
      row('d:d.com', { phone: '555-0002', status: 'working', touches: { email: '2026-11-25T00:00:00Z', linkedin: null, call: null } }),
    ])
    expect(accounts.map((a) => a.key)).toEqual(['d:b.com', 'd:d.com', 'd:a.com', 'd:c.com'])
    expect(more).toBe(0)
  })
  it('leaves out replied and dropped accounts, accounts already called, and Reddit authors', () => {
    const { accounts } = portalSignalAccounts([
      row('d:replied.com', { status: 'replied', phone: '1' }),
      row('d:dropped.com', { status: 'dropped', phone: '1' }),
      row('d:called.com', { phone: '1', touches: { email: null, linkedin: null, call: '2026-11-26T00:00:00Z' } }),
      row('r:pm_dave', { sources: ['reddit'] }),
      row('n:blue door'),
    ])
    expect(accounts.map((a) => a.key)).toEqual(['n:blue door'])
  })
  it('shows what the client needs and nothing of the owner’s working state', () => {
    const { accounts } = portalSignalAccounts([row('d:acme.com', { name: 'Acme PM', phone: '(310) 555-0101', deal_id: 'deal-1', aliases: ['n:acme pm'], contacts: [{ name: 'Ada', title: 'COO', linkedin: 'https://linkedin.com/in/ada' }, { name: 'Bob', title: null, linkedin: null }] })])
    expect(Object.keys(accounts[0]).sort()).toEqual(['called_at', 'company', 'contact', 'key', 'phone', 'signal_at', 'sources', 'status', 'untrusted_signal', 'website'])
    expect(accounts[0].contact).toEqual({ name: 'Ada', title: 'COO', linkedin: 'https://linkedin.com/in/ada' })
    expect(JSON.stringify(accounts[0])).not.toContain('deal-1')
  })
  it('caps the list and says how many more there are', () => {
    const rows = Array.from({ length: 30 }, (_, i) => row('d:co' + i + '.com'))
    const { accounts, more } = portalSignalAccounts(rows)
    expect(accounts).toHaveLength(25)
    expect(more).toBe(5)
    expect(portalSignalAccounts([])).toEqual({ accounts: [], more: 0 })
  })
})
