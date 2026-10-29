import { beforeEach, describe, expect, it, vi } from 'vitest'

const call = vi.hoisted(() => vi.fn())
vi.mock('@/lib/adapters/instantlyLeads', () => ({ instantlyCall: call }))

import { BLOCKLIST_MAX_PAGES, isBlocked } from '@/lib/adapters/instantlyLabels'

const page = (values: string[], next: string | null = null) => ({ items: values.map((bl_value) => ({ bl_value })), ...(next ? { next_starting_after: next } : {}) })
const fill = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${i}@other.com`)

beforeEach(() => call.mockReset())

describe('isBlocked', () => {
  it('an exact address or domain match blocks', async () => {
    call.mockResolvedValueOnce(page(['ada@acme.com']))
    expect(await isBlocked('Ada@Acme.com')).toBe(true)
    call.mockResolvedValueOnce(page([])).mockResolvedValueOnce(page(['acme.com']))
    expect(await isBlocked('ada@acme.com')).toBe(true)
  })

  it('substring hits are not matches', async () => {
    call.mockResolvedValueOnce(page(['xada@acme.com'])).mockResolvedValueOnce(page(['subacme.com']))
    expect(await isBlocked('ada@acme.com')).toBe(false)
  })

  it('pages through a full page until it finds the match', async () => {
    call
      .mockResolvedValueOnce(page(fill(100, 'a'), 'cur1'))
      .mockResolvedValueOnce(page(['ada@acme.com']))
    expect(await isBlocked('ada@acme.com')).toBe(true)
    expect(String(call.mock.calls[1][1])).toContain('starting_after=cur1')
  })

  it('more pages than it may read, with no exact match: unverifiable, it throws (callers refuse)', async () => {
    call.mockResolvedValue(page(fill(100, 'z'), 'more'))
    await expect(isBlocked('ada@acme.com')).rejects.toThrow(/blocklist_unverifiable/)
    expect(call.mock.calls.length).toBe(BLOCKLIST_MAX_PAGES)
  })

  it('a full page with no cursor is also unverifiable', async () => {
    call.mockResolvedValueOnce(page(fill(100, 'z')))
    await expect(isBlocked('ada@acme.com')).rejects.toThrow(/blocklist_unverifiable/)
  })
})
