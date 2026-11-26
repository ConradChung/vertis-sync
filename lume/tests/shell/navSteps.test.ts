import { describe, expect, it } from 'vitest'
import { ADMIN, FLOW, MORE, NAV, navLabel, PRIMARY, tabForChord, VOLUME } from '@/components/shell/nav'
import { TABS } from '@/components/shell/tabs'

describe('nav groups (90-day regroup)', () => {
  it('primary tabs are Today, Signals, Pipeline, Replies, Agent, in that order', () => {
    expect(PRIMARY.map((t) => t.label)).toEqual(['Today', 'Signals', 'Pipeline', 'Replies', 'Agent'])
    expect(TABS.filter((t) => t.primary).map((t) => t.label)).toEqual(PRIMARY.map((t) => t.label))
  })

  it('Volume holds Import, Leads, Progress, Rotate, Campaigns; Admin holds Playground, Operator, Settings', () => {
    expect(VOLUME.map((t) => t.label)).toEqual(['Import', 'Leads', 'Progress', 'Rotate', 'Campaigns'])
    expect(ADMIN.map((t) => t.label)).toEqual(['Playground', 'Operator', 'Settings'])
  })

  it('no page lost its place: every old tab URL is still a tab or a ⌘K page', () => {
    const hrefs = NAV.map((t) => t.href)
    for (const href of ['/import', '/import/leads', '/progress', '/calendar', '/rotate', '/campaigns', '/crm', '/agent', '/playground', '/actions', '/operator', '/settings']) {
      expect(hrefs, href).toContain(href)
    }
    expect(MORE.map((t) => t.href)).toContain('/calendar')
    expect(new Set(NAV.map((t) => t.key).filter(Boolean)).size).toBe(NAV.filter((t) => t.key).length)
  })

  it('primary letters: ⌥D Today, ⌥G Signals, ⌥L Pipeline, ⌥Y Replies, ⌥A Agent; the old ⌥O and ⌥C still work', () => {
    expect(['KeyD', 'KeyG', 'KeyL', 'KeyY', 'KeyA'].map((c) => tabForChord(c)?.label)).toEqual(['Today', 'Signals', 'Pipeline', 'Replies', 'Agent'])
    expect(tabForChord('KeyO')?.label).toBe('Today')
    expect(tabForChord('KeyC')?.label).toBe('Pipeline')
    expect(tabForChord('KeyK')?.href).toBe('/calendar')
    expect(tabForChord('KeyS')?.href).toBe('/settings')
  })
})

describe('nav flow numbering (GTM-18)', () => {
  it('numbers the flow by the lead steps; Lead lists holds steps 2 and 3', () => {
    expect(FLOW.map((t) => [t.href, t.step, t.key])).toEqual([
      ['/import', '1', '1'],
      ['/import/leads', '2–3', '2'],
      ['/progress', '4', '4'],
      ['/campaigns', '5', '5'],
    ])
    expect(navLabel(FLOW[2])).toBe('4 Progress')
  })

  it('Rotate is an unnumbered tool on Alt+T', () => {
    const rotate = VOLUME.find((t) => t.href === '/rotate')!
    expect(rotate.step).toBeUndefined()
    expect(rotate.key).toBe('T')
    expect(navLabel(rotate)).toBe('Rotate')
    expect(tabForChord('KeyT')?.href).toBe('/rotate')
  })

  it('Alt+2 and Alt+3 both open Lead lists; Alt+4 Progress', () => {
    expect(tabForChord('Digit2')?.href).toBe('/import/leads')
    expect(tabForChord('Digit3')?.href).toBe('/import/leads')
    expect(tabForChord('Numpad4')?.href).toBe('/progress')
    expect(tabForChord('Digit9')).toBeUndefined()
  })
})
