import { describe, expect, it, vi } from 'vitest'
import { parseHiringConfig } from '@/lib/hiring/config'
import { runDoorBackfill, type BackfillStore, type MissingRow } from '@/lib/hiring/doorsBackfill'
import { NO_DOORS } from '@/lib/hiring/checkPrompt'

const NOW = new Date('2026-11-27T20:00:00Z')
const row = (id: number, name: string, domain: string | null = null): MissingRow => ({ id, signal: 'hiring', company_name: name, company_domain: domain, location: 'Austin, TX' })
const found = { door_count: 1200, door_count_source: 'https://a.com/about', door_count_confidence: 'high' as const }

function setup(rows: MissingRow[], mtd = 0, cap = 40) {
  const spend: { usd: number; row_id: number }[] = []
  const saved: { ids: number[]; key: string; count: number }[] = []
  const store: BackfillStore = {
    getConfig: async () => parseHiringConfig({ monthly_cap_usd: cap }),
    monthSpend: async () => mtd + spend.reduce((a, s) => a + s.usd, 0),
    addSpend: async (e) => void spend.push({ usd: e.usd, row_id: e.row_id }),
    listMissing: async () => rows,
    saveDoors: async (ids, key, d) => void saved.push({ ids, key, count: d.door_count }),
  }
  return { store, spend, saved }
}

describe('runDoorBackfill', () => {
  it('looks a company up once for all its rows, saves a grounded count on every row, and leaves a miss null', async () => {
    const s = setup([row(1, 'Acme PM', 'acme.com'), row(2, 'Acme PM', 'acme.com'), row(3, 'Nowhere Homes')])
    const lookup = vi.fn(async (c: string) => ({ doors: c === 'Acme PM' ? found : NO_DOORS, usd: 0.007 }))
    const r = await runDoorBackfill({ store: s.store, lookup, now: NOW })
    expect(lookup).toHaveBeenCalledTimes(2)
    expect(s.saved).toEqual([{ ids: [1, 2], key: 'acme.com', count: 1200 }])
    expect(r).toMatchObject({ companies: 2, looked_up: 2, found: 1, rows_filled: 2, stopped: 'done' })
    expect(r.spent_usd).toBeCloseTo(0.014, 6)
    expect(s.spend).toHaveLength(2) // every lookup is in the lane's ledger
  })

  it('stops when the monthly cap would be passed (fitsCap), without calling the lookup', async () => {
    const s = setup([row(1, 'Acme PM', 'acme.com')], 39.999)
    const lookup = vi.fn(async () => ({ doors: found, usd: 0.007 }))
    const r = await runDoorBackfill({ store: s.store, lookup, now: NOW })
    expect(lookup).not.toHaveBeenCalled()
    expect(r).toMatchObject({ looked_up: 0, stopped: 'monthly_cap' })
  })

  it('stops at its own $1 budget', async () => {
    const rows = Array.from({ length: 200 }, (_, i) => row(i + 1, `Co ${i}`, `co${i}.com`))
    const s = setup(rows)
    const lookup = vi.fn(async () => ({ doors: NO_DOORS, usd: 0.0075 }))
    const r = await runDoorBackfill({ store: s.store, lookup, now: NOW })
    expect(r.stopped).toBe('budget')
    expect(r.spent_usd).toBeLessThanOrEqual(1)
    expect(r.looked_up).toBeGreaterThan(100)
    expect(r.looked_up).toBeLessThan(200)
  })

  it('a failed lookup stops the run and reports it; what was done is kept', async () => {
    const s = setup([row(1, 'A', 'a.com'), row(2, 'B', 'b.com')])
    let n = 0
    const lookup = vi.fn(async () => {
      if (n++ === 1) throw new Error('perplexity HTTP 429')
      return { doors: found, usd: 0.007 }
    })
    const r = await runDoorBackfill({ store: s.store, lookup, now: NOW })
    expect(r).toMatchObject({ found: 1, stopped: 'error', error: 'perplexity HTTP 429' })
    expect(s.saved).toHaveLength(1)
  })
})
