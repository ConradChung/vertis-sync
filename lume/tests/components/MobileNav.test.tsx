// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'dark', setTheme: vi.fn() }) }))

import { MobileNav } from '@/components/shell/MobileNav'
import { TABS } from '@/components/shell/tabs'

afterEach(cleanup)

describe('MobileNav (phones)', () => {
  it('shows the four primary tabs plus More in the bottom bar, marking the current page', () => {
    render(<MobileNav pathname="/agent" warm={vi.fn()} />)
    const bar = screen.getByRole('navigation', { name: 'Primary' })
    const links = within(bar).getAllByRole('link').map((a) => a.textContent)
    expect(links).toEqual(TABS.filter((t) => t.primary).map((t) => t.label))
    expect(within(bar).getByRole('link', { name: 'Agent' }).getAttribute('aria-current')).toBe('page')
    expect(within(bar).getByRole('button', { name: 'More' })).toBeTruthy()
    // Current page name in the slim header.
    expect(screen.getAllByText('Agent').length).toBeGreaterThan(1)
  })

  it('opens More with every other tab, and labels the button with a secondary page when on one', () => {
    const { rerender } = render(<MobileNav pathname="/overview" warm={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    for (const t of TABS.filter((x) => !x.primary)) expect(screen.getByRole('link', { name: t.label })).toBeTruthy()
    rerender(<MobileNav pathname="/playground" warm={vi.fn()} />)
    expect(within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('button', { name: 'Playground' })).toBeTruthy()
  })

  it('opens the command palette from the search button', () => {
    const on = vi.fn()
    window.addEventListener('lume:open-palette', on)
    render(<MobileNav pathname="/crm" warm={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    expect(on).toHaveBeenCalledTimes(1)
    window.removeEventListener('lume:open-palette', on)
  })
})
