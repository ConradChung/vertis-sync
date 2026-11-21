import { beforeEach, describe, expect, it, vi } from 'vitest'
const w = vi.hoisted(() => ({ getCampaignDetail: vi.fn(), sourceHash: vi.fn() }))
vi.mock('@/lib/adapters/instantlyWrite', () => w)
import { duplicateNotices } from '@/lib/actions/duplicateNotice'

const row = (over: Record<string, unknown> = {}) =>
  ({ kind: 'create_campaign', status: 'awaiting', payload: { source_campaign_id: 'S1', name: 'Copy', source_hash: 'a'.repeat(32) }, result: null, ...over }) as never

beforeEach(() => {
  w.getCampaignDetail.mockReset().mockResolvedValue({})
  w.sourceHash.mockReset()
})

describe('approval card: duplicate source changed?', () => {
  it('no notice when the source is unchanged', async () => {
    w.sourceHash.mockReturnValue('a'.repeat(32))
    expect(await duplicateNotices(row())).toEqual([])
  })
  it('warns when the source changed since the request', async () => {
    w.sourceHash.mockReturnValue('b'.repeat(32))
    expect((await duplicateNotices(row()))[0]).toMatch(/Confirm will be refused/)
  })
  it('says it cannot check when the source is unreadable or the row has no fingerprint', async () => {
    w.getCampaignDetail.mockRejectedValue(new Error('404'))
    expect((await duplicateNotices(row()))[0]).toMatch(/Could not read/)
    expect((await duplicateNotices(row({ payload: { source_campaign_id: 'S1', name: 'Copy' } })))[0]).toMatch(/no source fingerprint/)
  })
  it('after it ran, reports from the result without calling Instantly', async () => {
    expect((await duplicateNotices(row({ status: 'executed', result: { source_changed: true } })))[0]).toMatch(/copy was refused/)
    expect(await duplicateNotices(row({ status: 'executed', result: { source_changed: false } }))).toEqual([])
    expect(w.getCampaignDetail).not.toHaveBeenCalled()
  })
  it('other kinds get nothing', async () => {
    expect(await duplicateNotices(row({ kind: 'pause_campaign' }))).toEqual([])
  })
})
