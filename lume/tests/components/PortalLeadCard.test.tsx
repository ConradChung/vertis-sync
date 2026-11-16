// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { LeadCard } from '@/components/portal/LeadCard'
import type { PortalLead } from '@/lib/portal/types'

afterEach(cleanup)

const lead = (over: Partial<PortalLead> = {}): PortalLead => ({
  id: '1', kind: 'email', name: 'Dana Reyes', first_name: 'Dana', title: 'Property Manager', company: 'Greystar',
  phone: '+1 (214) 555-0100', phone_type: 'mobile', email: 'dana@greystar.com', website: 'greystar.com',
  linkedin_url: 'https://linkedin.com/in/dana', city: 'Dallas', state: 'TX', country: 'US', region: 'Texas',
  timezone: 'America/Chicago', campaign: 'Kaspen Main', reply_status: 'Interested', opened: true, replied: false,
  ...over,
})
const NOW = new Date('2026-11-11T15:41:00Z')

describe('portal LeadCard', () => {
  it('renders a normalised tel: link with the display formatting kept', () => {
    render(<LeadCard lead={lead()} now={NOW} />)
    const call = screen.getByRole('link', { name: /Call Dana Reyes/ })
    expect(call.getAttribute('href')).toBe('tel:+12145550100')
    expect(call.textContent).toContain('+1 (214) 555-0100')
    expect(screen.queryByText(/Company line/)).toBeNull()
  })

  it('hints a company switchboard and who to ask for', () => {
    render(<LeadCard lead={lead({ phone_type: 'company' })} now={NOW} />)
    expect(screen.getByText('Company line — ask for Dana')).toBeTruthy()
  })

  it('shows local time, status, markers and safe external links', () => {
    render(<LeadCard lead={lead()} now={NOW} />)
    expect(screen.getByText('9:41 AM')).toBeTruthy()
    expect(screen.getByText('(business hours)')).toBeTruthy()
    expect(screen.getByText('Interested')).toBeTruthy()
    expect(screen.getByText('Opened')).toBeTruthy()
    expect(screen.getByRole('link', { name: /Email Dana/ }).getAttribute('href')).toBe('mailto:dana@greystar.com')
    const site = screen.getByRole('link', { name: /Website/ })
    expect(site.getAttribute('href')).toBe('https://greystar.com')
    expect(site.getAttribute('target')).toBe('_blank')
    expect(site.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('falls back to city/country without a zone, and says when there is no phone', () => {
    render(<LeadCard lead={lead({ timezone: null, phone: null })} now={NOW} />)
    expect(screen.getByText('Dallas, TX')).toBeTruthy()
    expect(screen.getByText('No phone')).toBeTruthy()
  })
})
