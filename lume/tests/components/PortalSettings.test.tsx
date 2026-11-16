// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const sendJson = vi.hoisted(() => vi.fn())
vi.mock('@/lib/validate/client', () => ({ sendJson }))

import { PortalSettings } from '@/components/settings/PortalSettings'

const writeText = vi.fn()
beforeEach(() => {
  sendJson.mockReset()
  writeText.mockReset()
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})
afterEach(cleanup)

describe('Settings → Client portal', () => {
  it('prefills Frank, copies a sign-in link and links the preview', async () => {
    sendJson.mockResolvedValue({ status: 200, body: { url: 'https://lume.example/auth/portal?t=abc', expires_in_minutes: 60 } })
    writeText.mockResolvedValue(undefined)
    render(<PortalSettings />)
    expect((screen.getByLabelText('Client email') as HTMLInputElement).value).toBe('frank@getzenport.com')
    expect(screen.getByText('Open portal preview').closest('a')?.getAttribute('href')).toBe('/portal?as=frank%40getzenport.com')

    fireEvent.click(screen.getByRole('button', { name: /Copy sign-in link/ }))
    expect(await screen.findByText('Link copied — valid ~60 min, single use.')).toBeTruthy()
    expect(sendJson).toHaveBeenCalledWith('/api/portal/sign-in-link', { email: 'frank@getzenport.com' })
    expect(writeText).toHaveBeenCalledWith('https://lume.example/auth/portal?t=abc')
  })

  it('shows the server error', async () => {
    sendJson.mockResolvedValue({ status: 404, body: { error: 'Not a portal user' } })
    render(<PortalSettings />)
    fireEvent.click(screen.getByRole('button', { name: /Copy sign-in link/ }))
    expect(await screen.findByText('Not a portal user')).toBeTruthy()
  })
})
