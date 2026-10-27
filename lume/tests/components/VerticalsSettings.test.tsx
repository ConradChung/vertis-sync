// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SWRConfig } from 'swr'

const VID = '3941b73f-c74e-4cc5-9766-f0140e6ad9c9'
const data: Record<string, unknown> = {
  '/api/verticals?archived=1': {
    verticals: [{ id: VID, name: 'Roofers', campaign_ids: ['gmail:x'], scopes: ['campaign'], is_default: false, created_at: '', archived_at: null }],
  },
  '/api/operators': {
    operators: [{ id: 'op1', vertical_id: VID, is_master: false, label: 'Roofers bot', created_at: '2026-10-26T00:00:00Z', revoked_at: null, last_seen_at: null }],
  },
  '/api/campaigns': [{ external_id: 'c-1', name: 'Roof R1' }],
  '/api/instantly/campaigns': { configured: true, campaigns: [{ id: 'c-2', name: 'Roof R2', status: 1 }] },
}
const sendJson = vi.hoisted(() => vi.fn())
vi.mock('@/lib/validate/client', () => ({ sendJson }))
vi.mock('@/hooks/fetcher', () => ({ fetchJson: async (k: string) => data[k] }))

import { VerticalsSettings } from '@/components/settings/VerticalsSettings'

const ui = (canManageKeys: boolean) =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <VerticalsSettings canManageKeys={canManageKeys} />
    </SWRConfig>
  )

beforeEach(() => sendJson.mockReset())
afterEach(cleanup)

describe('Settings → Verticals', () => {
  it('lists verticals with campaigns from the registry and Instantly, plus unknown ids', async () => {
    ui(true)
    await screen.findByDisplayValue('Roofers')
    expect(screen.getAllByText('Roof R1').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Roof R2').length).toBeGreaterThan(0)
    expect(screen.getByText('gmail:x')).toBeTruthy()
    expect(screen.getByText('Roofers bot')).toBeTruthy()
  })

  it('minting shows the full sign-in link once, with a copy button', async () => {
    sendJson.mockResolvedValue({ status: 201, body: { operator: {}, sign_in_url: 'https://lume.test/auth/operator?k=RAW' } })
    ui(true)
    await screen.findByDisplayValue('Roofers')
    fireEvent.click(screen.getByRole('button', { name: 'Generate key' }))
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
    await waitFor(() => expect(screen.getByLabelText('Sign-in link')).toBeTruthy())
    expect((screen.getByLabelText('Sign-in link') as HTMLInputElement).value).toBe('https://lume.test/auth/operator?k=RAW')
    expect(sendJson).toHaveBeenCalledWith('/api/operators', { vertical_id: VID, label: 'Roofers bot' }, { method: 'POST' })
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByLabelText('Sign-in link')).toBeNull()
  })

  it('a Grok Bot session sees keys but no mint or revoke', async () => {
    ui(false)
    await screen.findByText('Roofers bot')
    expect(screen.queryByRole('button', { name: 'Generate key' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'New master key' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull()
  })

  it('creating a vertical posts name, scopes and campaigns', async () => {
    sendJson.mockResolvedValue({ status: 201, body: { vertical: {} } })
    ui(true)
    await screen.findByDisplayValue('Roofers')
    fireEvent.change(screen.getByPlaceholderText('New vertical name'), { target: { value: 'Dentists' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create vertical' }))
    await waitFor(() =>
      expect(sendJson).toHaveBeenCalledWith('/api/verticals', { name: 'Dentists', scopes: [], campaign_ids: [], is_default: false }, { method: 'POST' })
    )
  })
})
