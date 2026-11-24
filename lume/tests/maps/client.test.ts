import { describe, expect, it } from 'vitest'
import { isRunId, mapsErrorMessage, sheetLine } from '@/lib/maps/client'

describe('Maps card helpers', () => {
  it('run ids', () => {
    expect(isRunId(' AbCdEfGh1234 ')).toBe(true)
    expect(isRunId('abc')).toBe(false)
    expect(isRunId('https://console.apify.com/x')).toBe(false)
  })
  it('error lines', () => {
    expect(mapsErrorMessage({ status: 0, body: null, aborted: true })).toMatch(/Timed out/)
    expect(mapsErrorMessage({ status: 409, body: { error: 'run_not_finished: RUNNING' } })).toBe("The run hasn't finished yet (running).")
    expect(mapsErrorMessage({ status: 422, body: { error: 'not_a_maps_dataset' } })).toBe("That run isn't a Google Maps scrape.")
    expect(mapsErrorMessage({ status: 500, body: null })).toBe('Failed (HTTP 500).')
  })
  it('the sheet line notes partial runs and list overflow', () => {
    const line = sheetLine({
      ok: true, list_id: 'L1', list_name: 'LA PM', href: '/import/leads?list=L1', summary: '2 companies kept of 3 places.', truncated: false, run_status: 'TIMED-OUT',
      append: { added: 2, duplicates: 0, over_cap: 1, item_count: 2 }, clean: { kept: 3, with_phone: 2, pm_category: 2, total: 3 },
    })
    expect(line).toBe('2 companies in “LA PM”, 2 with a phone. 2 companies kept of 3 places. The run ended timed-out, so the sheet is partial. 1 more did not fit the list.')
  })
})
