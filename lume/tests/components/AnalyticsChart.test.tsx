// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { AnalyticsChart } from '@/components/campaigns/AnalyticsChart'
import { allZero, lastActiveDate } from '@/lib/campaigns/chart'
import type { CampaignAnalyticsResponse } from '@/lib/campaigns/types'

// jsdom has no layout: give ResponsiveContainer a real size.
beforeAll(() => {
  globalThis.ResizeObserver = class {
    constructor(private cb: ResizeObserverCallback) {}
    observe(el: Element) {
      this.cb([{ target: el, contentRect: { width: 600, height: 240 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver)
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  HTMLElement.prototype.getBoundingClientRect = () => ({ width: 600, height: 240, top: 0, left: 0, right: 600, bottom: 240, x: 0, y: 0, toJSON() {} }) as DOMRect
})
afterEach(cleanup)

const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10)

function payload(daily: CampaignAnalyticsResponse['daily']): CampaignAnalyticsResponse {
  return {
    configured: true,
    campaign_id: 'c1',
    days: 7,
    overview: { sent: 906, replies: 4, reply_rate: 0.4, opportunities: 2, bounced: 0 },
    daily,
    steps: [],
  } as CampaignAnalyticsResponse
}

function curves(container: HTMLElement) {
  return [...container.querySelectorAll('.recharts-area-curve')]
}

describe('AnalyticsChart', () => {
  it('draws a stroked area per series with live data', () => {
    const daily = [0, 1, 2].map((o) => ({ date: day(o), sent: 180, replies: 1, opportunities: 1 }))
    const { container } = render(<AnalyticsChart data={payload(daily)} failed={false} days={7} onDays={() => {}} />)
    const lines = curves(container)
    expect(lines).toHaveLength(3)
    for (const l of lines) {
      expect(l.getAttribute('stroke')).toMatch(/^var\(--color-(sent|replies|opportunities)\)$/)
      expect(l.getAttribute('d')).toBeTruthy()
    }
    expect(container.querySelectorAll('.recharts-area-area[fill^="url(#fill-"]')).toHaveLength(3)
    expect(screen.queryByTestId('chart-empty')).toBeNull()
  })

  // Regression: stacked areas + an all-zero window rendered nothing (no lines, no Y axis), only the tooltip.
  it('still draws the series and Y axis when the whole window is zero', () => {
    const daily = [{ date: day(10), sent: 6, replies: 1, opportunities: 0 }]
    const { container } = render(<AnalyticsChart data={payload(daily)} failed={false} days={7} onDays={() => {}} />)
    expect(curves(container)).toHaveLength(3)
    expect(container.querySelectorAll('.recharts-yAxis .recharts-cartesian-axis-tick').length).toBeGreaterThan(0)
    expect(screen.getByTestId('chart-empty').textContent).toContain(`last activity ${day(10)}`)
  })

  it('config colors resolve through the ChartStyle vars', () => {
    const { container } = render(<AnalyticsChart data={payload([])} failed={false} days={7} onDays={() => {}} />)
    const css = container.querySelector('[data-slot=chart] style')?.innerHTML ?? ''
    expect(css).toContain('--color-sent: var(--violet)')
    expect(css).toContain('--color-replies: var(--green)')
    expect(css).toContain('--color-opportunities: var(--amber)')
  })
})

describe('chart helpers', () => {
  it('allZero / lastActiveDate', () => {
    expect(allZero([{ a: 0, b: 0 }], ['a', 'b'])).toBe(true)
    expect(allZero([{ a: 0, b: 2 }], ['a', 'b'])).toBe(false)
    expect(
      lastActiveDate([
        { date: '2026-10-19', sent: 6, replies: 0, opportunities: 0 },
        { date: '2026-10-18', sent: 180, replies: 0, opportunities: 0 },
        { date: '2026-10-20', sent: 0, replies: 0, opportunities: 0 },
      ]),
    ).toBe('2026-10-19')
    expect(lastActiveDate([])).toBeUndefined()
  })
})
