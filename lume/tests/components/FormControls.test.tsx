// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DatePicker, parseIsoDate } from '@/components/ui/date-picker'
import { SimpleSelect } from '@/components/ui/simple-select'
import { AnimatedNumber } from '@/components/ui/animated-number'

afterEach(cleanup)

describe('parseIsoDate', () => {
  it('reads yyyy-mm-dd as a local date', () => {
    const d = parseIsoDate('2026-10-07')!
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 9, 7])
  })
  it('rejects anything else', () => {
    expect(parseIsoDate('')).toBeUndefined()
    expect(parseIsoDate('07/10/2026')).toBeUndefined()
    expect(parseIsoDate(undefined)).toBeUndefined()
  })
})

describe('DatePicker', () => {
  it('shows the placeholder when empty and the date when set, with a clear button', () => {
    const onChange = vi.fn()
    const { rerender } = render(<DatePicker value="" onChange={onChange} placeholder="Since" />)
    expect(screen.getByRole('button', { name: /Since/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Clear date' })).toBeNull()
    rerender(<DatePicker value="2026-10-07" onChange={onChange} placeholder="Since" />)
    expect(screen.getByText('7 Oct 2026')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear date' }))
    expect(onChange).toHaveBeenCalledWith('')
  })
})

describe('SimpleSelect', () => {
  it("labels the trigger with the selected option, including the '' option", () => {
    const opts = [
      { value: '', label: 'All sources' },
      { value: 'lead_bank', label: 'Queued' },
    ]
    const { rerender } = render(<SimpleSelect aria-label="Source" value="" onValueChange={() => {}} options={opts} />)
    expect(screen.getByRole('combobox', { name: 'Source' }).textContent).toContain('All sources')
    rerender(<SimpleSelect aria-label="Source" value="lead_bank" onValueChange={() => {}} options={opts} />)
    expect(screen.getByRole('combobox', { name: 'Source' }).textContent).toContain('Queued')
  })
})

describe('AnimatedNumber', () => {
  it('renders the formatted final value where it cannot tick (no IntersectionObserver)', () => {
    render(<AnimatedNumber value={1240.5} decimals={1} suffix="%" />)
    expect(screen.getByText('1,240.5%')).toBeTruthy()
  })
})
