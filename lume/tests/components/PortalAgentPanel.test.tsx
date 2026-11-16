// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AgentPanel } from '@/components/portal/AgentPanel'
import type { PortalLead } from '@/lib/portal/types'

const LEAD: PortalLead = {
  id: '9', kind: 'email', name: 'Sam Ortiz', first_name: 'Sam', title: 'Property Manager', company: 'Greystar',
  phone: '214-555-0199', phone_type: 'company', email: null, website: null, linkedin_url: null, city: 'Dallas',
  state: 'TX', country: 'US', region: 'Texas', timezone: 'America/Chicago', campaign: null, reply_status: null,
  opened: false, replied: false,
}

const fetchMock = vi.fn()
beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const reply = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))

function ask(text: string) {
  fireEvent.change(screen.getByLabelText('Message the assistant'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
}

describe('portal AgentPanel', () => {
  it('sends the running message list and renders the reply with lead cards', async () => {
    fetchMock.mockImplementationOnce(() => reply({ reply: 'Found one at Greystar.', leads: [LEAD] }))
    render(<AgentPanel as="frank@getzenport.com" />)
    ask('Find the property manager at Greystar in Dallas')

    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true)
    expect(await screen.findByText('Found one at Greystar.')).toBeTruthy()
    const call = screen.getByRole('link', { name: /Call Sam Ortiz/ })
    expect(call.getAttribute('href')).toBe('tel:2145550199')
    expect(screen.getByText('Company line — ask for Sam')).toBeTruthy()

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/portal/agent?as=frank%40getzenport.com')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ messages: [{ role: 'user', content: 'Find the property manager at Greystar in Dallas' }] })

    fetchMock.mockImplementationOnce(() => reply({ reply: 'No mobile on file.', leads: [] }))
    ask('Does he have a mobile?')
    expect(await screen.findByText('No mobile on file.')).toBeTruthy()
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).messages).toEqual([
      { role: 'user', content: 'Find the property manager at Greystar in Dallas' },
      { role: 'assistant', content: 'Found one at Greystar.' },
      { role: 'user', content: 'Does he have a mobile?' },
    ])
  })

  it('shows errors inline and retries the same conversation', async () => {
    fetchMock.mockImplementationOnce(() => reply({ error: 'Assistant unavailable' }, 503))
    render(<AgentPanel />)
    ask('Who is in Austin?')
    expect((await screen.findByRole('alert')).textContent).toContain('Assistant unavailable')
    expect(fetchMock.mock.calls[0][0]).toBe('/api/portal/agent')

    fetchMock.mockImplementationOnce(() => reply({ reply: 'Two leads in Austin.', leads: [] }))
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }))
    expect(await screen.findByText('Two leads in Austin.')).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).messages).toEqual([{ role: 'user', content: 'Who is in Austin?' }])
  })
})
