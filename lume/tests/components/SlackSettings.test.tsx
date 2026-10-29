// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SWRConfig } from 'swr'

const VID = '0b4c1f2e-7d3a-4b9e-8f6a-2c1d3e4f5a6b'
const data: Record<string, unknown> = {}
const reset = () => {
  data['/api/slack/installs'] = {
    configured: true, missing: [],
    installs: [{ team_id: 'T0AAA', team_name: 'Acme Inc', created_at: '2026-10-29T00:00:00Z', revoked_at: null }],
    bindings: [{ id: 'b1', team_id: 'T0AAA', channel_id: 'C0AAA', channel_name: 'leads', vertical_id: VID, campaign_ids: ['c-1'], visible_fields: ['name', 'reply'], active: true }],
  }
  data['/api/verticals'] = { verticals: [{ id: VID, name: 'Roofers', campaign_ids: ['c-1', 'c-2'], archived_at: null }] }
  data['/api/campaigns'] = []
  data['/api/instantly/campaigns'] = { configured: true, campaigns: [{ id: 'c-1', name: 'Kaspen main' }, { id: 'c-2', name: 'Zenport' }] }
  data['/api/slack/installs/T0AAA/channels'] = { channels: [{ id: 'C0BBB', name: 'wins', is_private: false, is_member: true }] }
}
const sendJson = vi.hoisted(() => vi.fn())
vi.mock('@/lib/validate/client', () => ({ sendJson }))
vi.mock('@/hooks/fetcher', () => ({ fetchJson: async (k: string) => data[k] }))

import { SlackSettings } from '@/components/settings/SlackSettings'

const ui = (canManage = true) =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <SlackSettings canManage={canManage} />
    </SWRConfig>
  )

beforeEach(() => {
  reset()
  sendJson.mockReset()
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})
afterEach(cleanup)

describe('Settings → Slack', () => {
  it('lists workspaces and bindings with campaign names and visible fields', async () => {
    ui()
    expect(await screen.findByText('#leads')).toBeTruthy()
    expect(screen.getAllByText('Acme Inc').length).toBeGreaterThan(0)
    expect(screen.getByText(/Campaigns: Kaspen main · Fields: Name, Their reply/)).toBeTruthy()
  })

  it('generates an install link', async () => {
    sendJson.mockResolvedValue({ status: 200, body: { url: 'https://lume.example/api/slack/install?t=abc', expires_at: '2026-11-05T00:00:00Z' } })
    ui()
    await screen.findByText('#leads')
    fireEvent.click(screen.getByText('Generate link'))
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Install link' }) as HTMLInputElement).value).toBe('https://lume.example/api/slack/install?t=abc'))
    expect(sendJson).toHaveBeenCalledWith('/api/slack/install-link', { days: 7 }, { method: 'POST' })
  })

  it('binds a channel: channel, vertical, campaigns, fields', async () => {
    sendJson.mockResolvedValue({ status: 200, body: { binding: {} } })
    ui()
    await screen.findByText('#leads')
    fireEvent.click(screen.getByText('Bind a channel'))
    await screen.findByText('#wins')
    fireEvent.change(screen.getByRole('combobox', { name: /^Channel/ }), { target: { value: 'C0BBB' } })
    fireEvent.click(screen.getByLabelText('Zenport'))
    fireEvent.click(screen.getByLabelText('Phone'))
    fireEvent.click(screen.getByText('Save binding'))
    await waitFor(() => expect(sendJson).toHaveBeenCalled())
    const [url, body, opts] = sendJson.mock.calls[0]
    expect(url).toBe('/api/slack/channels')
    expect(opts).toEqual({ method: 'PUT' })
    expect(body).toMatchObject({ team_id: 'T0AAA', channel_id: 'C0BBB', channel_name: 'wins', vertical_id: VID, campaign_ids: ['c-2'], active: true })
    expect(body.visible_fields).not.toContain('phone')
    expect(body.visible_fields).toContain('name')
  })

  it('revokes a workspace after a confirm', async () => {
    sendJson.mockResolvedValue({ status: 200, body: { ok: true } })
    ui()
    await screen.findByText('#leads')
    fireEvent.click(screen.getByText('Revoke'))
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith('/api/slack/installs/T0AAA/revoke', {}, { method: 'POST' }))
  })

  it('shows "not configured" with the missing env names and disables the link', async () => {
    data['/api/slack/installs'] = { configured: false, missing: ['SLACK_SIGNING_SECRET', 'LUME_SLACK_TOKEN_KEY'], installs: [], bindings: [] }
    ui()
    expect(await screen.findByText('Slack app not configured')).toBeTruthy()
    expect(screen.getByText('SLACK_SIGNING_SECRET, LUME_SLACK_TOKEN_KEY')).toBeTruthy()
    expect((screen.getByText('Generate link') as HTMLButtonElement).disabled).toBe(true)
  })

  it('a Grok Bot session is read-only', async () => {
    ui(false)
    await screen.findByText('#leads')
    expect((screen.getByText('Generate link') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByText('Revoke') as HTMLButtonElement).disabled).toBe(true)
  })
})
