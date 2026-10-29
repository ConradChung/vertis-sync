// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SWRConfig } from 'swr'

const data: Record<string, unknown> = {
  '/api/campaigns/reply-mode': { modes: [{ campaign_id: 'c-2', mode: 'client' }] },
  '/api/instantly/campaigns': { configured: true, campaigns: [{ id: 'c-1', name: 'Kaspen main' }, { id: 'c-2', name: 'Zenport' }] },
}
const sendJson = vi.hoisted(() => vi.fn())
vi.mock('@/lib/validate/client', () => ({ sendJson }))
vi.mock('@/hooks/fetcher', () => ({ fetchJson: async (k: string) => data[k] }))

import { ReplyModesSettings } from '@/components/campaigns/ReplyModeSelect'

const ui = (canChange: boolean) =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ReplyModesSettings canChange={canChange} />
    </SWRConfig>
  )

beforeEach(() => {
  sendJson.mockReset()
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})
afterEach(cleanup)

describe('Reply approval modes', () => {
  it('lists Instantly campaigns, owner by default, and notes that client approval arrives with the Slack app', async () => {
    ui(true)
    const main = (await screen.findByLabelText('Reply approval for Kaspen main')) as HTMLSelectElement
    await waitFor(() => expect((screen.getByLabelText('Reply approval for Zenport') as HTMLSelectElement).value).toBe('client'))
    expect(main.value).toBe('owner')
    expect(screen.getByText('client approval arrives with the Slack app')).toBeTruthy()
  })

  it('switching to Auto asks first, then PUTs the mode', async () => {
    sendJson.mockResolvedValue({ status: 200, body: { campaign_id: 'c-1', mode: 'auto', from: 'owner' } })
    ui(true)
    fireEvent.change(await screen.findByLabelText('Reply approval for Kaspen main'), { target: { value: 'auto' } })
    expect(window.confirm).toHaveBeenCalled()
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith('/api/campaigns/reply-mode', { campaign_id: 'c-1', mode: 'auto' }, { method: 'PUT' }))
  })

  it('declining the confirm changes nothing', async () => {
    vi.mocked(window.confirm).mockReturnValue(false)
    ui(true)
    fireEvent.change(await screen.findByLabelText('Reply approval for Kaspen main'), { target: { value: 'auto' } })
    expect(sendJson).not.toHaveBeenCalled()
  })

  it('a Grok Bot session sees the modes read-only', async () => {
    ui(false)
    expect(((await screen.findByLabelText('Reply approval for Kaspen main')) as HTMLSelectElement).disabled).toBe(true)
    expect(screen.getByText(/Signed in as a Grok Bot/)).toBeTruthy()
  })

  it('a refusal is shown', async () => {
    sendJson.mockResolvedValue({ status: 403, body: { error: 'operator_forbidden' } })
    ui(true)
    fireEvent.change(await screen.findByLabelText('Reply approval for Kaspen main'), { target: { value: 'owner' } })
    fireEvent.change(screen.getByLabelText('Reply approval for Kaspen main'), { target: { value: 'client' } })
    await screen.findByText('Only your own browser session can change a reply mode.')
  })
})
