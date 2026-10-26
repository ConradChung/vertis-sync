// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

import { SWRConfig } from 'swr'

// cmdk scrolls the active item into view and measures the list.
Element.prototype.scrollIntoView = () => {}
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver
import { CommandPalette } from '@/components/shell/CommandPalette'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const respond = (url: string) => {
  if (url.startsWith('/api/instantly/campaigns')) return { configured: true, campaigns: [{ id: 'c-1', name: 'Kaspen Q4', status: 1, statusLabel: 'active' }] }
  if (url.startsWith('/api/campaigns')) return [{ external_id: 'gmail:recruiter', name: 'Recruiter (Gmail)' }]
  if (url.startsWith('/api/orders')) return [{ kind: 'ingest', id: 'o1', summary: 'leads.csv', row_count: 120 }]
  if (url.startsWith('/api/rules')) return [{ id: 'r1', name: 'Weekday drip', cron: '0 8 * * 1-5' }]
  if (url.startsWith('/api/crm/search')) return { deals: [] }
  return {}
}

describe('CommandPalette', () => {
  it('opens on ⌘K and lists campaigns, orders and rules; picking a campaign opens its CRM', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(respond(url)), { status: 200 })))
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <CommandPalette />
      </SWRConfig>
    )
    await act(async () => {
      fireEvent.keyDown(window, { key: 'k', metaKey: true })
    })
    expect(await screen.findByText('Kaspen Q4')).toBeTruthy()
    expect(await screen.findByText('Recruiter (Gmail)')).toBeTruthy()
    expect(await screen.findByText('leads.csv')).toBeTruthy()
    expect(await screen.findByText('Weekday drip')).toBeTruthy()
    fireEvent.click(screen.getByText('Kaspen Q4'))
    expect(push).toHaveBeenCalledWith('/crm?campaign=c-1')
  })
})
