import { describe, expect, it } from 'vitest'
import { FLOW, navLabel, tabForChord, TOOLS } from '@/components/shell/nav'

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
    const rotate = TOOLS.find((t) => t.href === '/rotate')!
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
