// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SWRConfig } from 'swr'

const VID = '3941b73f-c74e-4cc5-9766-f0140e6ad9c9'
const data: Record<string, unknown> = {}
const sendJson = vi.hoisted(() => vi.fn())
vi.mock('@/lib/validate/client', () => ({ sendJson }))
vi.mock('@/hooks/fetcher', () => ({ fetchJson: async (k: string) => data[k] }))

import { WebhookPanel } from '@/components/settings/WebhookPanel'

const ui = (canManage = true) =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <WebhookPanel verticalId={VID} verticalName="Roofers" canManage={canManage} />
    </SWRConfig>
  )

beforeEach(() => {
  sendJson.mockReset()
  data[`/api/verticals/${VID}/webhook`] = { webhook: null }
})
afterEach(cleanup)

describe('WebhookPanel', () => {
  it('saving with no secret shows the generated one once', async () => {
    sendJson.mockResolvedValue({ status: 200, body: { webhook: {}, secret: 'GENERATED-SECRET-123456' } })
    ui()
    fireEvent.change(screen.getByLabelText('Webhook URL'), { target: { value: 'https://grok.test/hook' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save webhook' }))
    await waitFor(() => expect((screen.getByLabelText('Generated webhook secret') as HTMLInputElement).value).toBe('GENERATED-SECRET-123456'))
    expect(sendJson).toHaveBeenCalledWith(`/api/verticals/${VID}/webhook`, { url: 'https://grok.test/hook' }, { method: 'PUT' })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByLabelText('Generated webhook secret')).toBeNull()
  })

  it('a stored webhook shows the masked secret only, and Send test reports the outcome', async () => {
    data[`/api/verticals/${VID}/webhook`] = {
      webhook: { vertical_id: VID, url: 'https://grok.test/hook', secret_masked: '••••2345', updated_at: '', last_delivery_at: null, last_delivery_ok: null, last_error: null },
    }
    sendJson.mockResolvedValue({ status: 200, body: { ok: false, error: 'HTTP 500', attempts: 2 } })
    ui()
    await screen.findByText(/Secret ••••2345/)
    fireEvent.click(screen.getByRole('button', { name: 'Send test' }))
    await screen.findByText('Test failed: HTTP 500 after 2 attempt(s).')
    expect(sendJson).toHaveBeenCalledWith(`/api/verticals/${VID}/webhook/test`, {})
  })

  it('a URL refusal is explained', async () => {
    sendJson.mockResolvedValue({ status: 400, body: { error: 'private_host' } })
    ui()
    fireEvent.change(screen.getByLabelText('Webhook URL'), { target: { value: 'https://10.0.0.1/h' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save webhook' }))
    await screen.findByText(/public host name/)
  })

  it('read-only for a Grok Bot session', async () => {
    ui(false)
    expect((screen.getByLabelText('Webhook URL') as HTMLInputElement).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: 'Save webhook' })).toBeNull()
  })

  it('Regenerate secret asks, then PUTs regenerate_secret and shows the new one once', async () => {
    data[`/api/verticals/${VID}/webhook`] = {
      webhook: { vertical_id: VID, url: 'https://grok.test/hook', secret_masked: '••••2345', updated_at: '', last_delivery_at: null, last_delivery_ok: null, last_error: null },
    }
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    sendJson.mockResolvedValue({ status: 200, body: { webhook: {}, secret: 'NEW-SECRET-abcdefghijklmnop' } })
    ui()
    fireEvent.click(await screen.findByRole('button', { name: 'Regenerate secret' }))
    await waitFor(() => expect((screen.getByLabelText('Generated webhook secret') as HTMLInputElement).value).toBe('NEW-SECRET-abcdefghijklmnop'))
    expect(sendJson).toHaveBeenCalledWith(`/api/verticals/${VID}/webhook`, { url: 'https://grok.test/hook', regenerate_secret: true }, { method: 'PUT' })
  })
})
