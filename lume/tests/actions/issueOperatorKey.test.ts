import { beforeEach, describe, expect, it, vi } from 'vitest'

const ops = vi.hoisted(() => ({ getVertical: vi.fn() }))
vi.mock('@/lib/operators/store', () => ops)

import { buildActionRequest } from '@/lib/actions/build'

const VID = '3941b73f-c74e-4cc5-9766-f0140e6ad9c9'
beforeEach(() => ops.getVertical.mockReset())

describe('buildActionRequest: issue_operator_key', () => {
  it('snapshots the vertical and a server-written summary (default label)', async () => {
    ops.getVertical.mockResolvedValue({ id: VID, name: 'Roofers', archived_at: null })
    const b = await buildActionRequest({ kind: 'issue_operator_key', payload: { vertical_id: VID.toUpperCase() } })
    expect(b).toEqual({
      ok: true,
      kind: 'issue_operator_key',
      payload: {
        vertical_id: VID,
        vertical_name: 'Roofers',
        label: 'Roofers bot',
        summary: expect.stringContaining('Issue a Grok Bot operator key “Roofers bot” for the Roofers vertical'),
      },
    })
    expect(ops.getVertical).toHaveBeenCalledWith(VID)
  })

  it('404 for a missing or archived vertical; 400 for a master request', async () => {
    ops.getVertical.mockResolvedValue({ id: VID, name: 'R', archived_at: '2026-01-01' })
    expect(await buildActionRequest({ kind: 'issue_operator_key', payload: { vertical_id: VID } })).toMatchObject({ ok: false, status: 404 })
    expect(await buildActionRequest({ kind: 'issue_operator_key', payload: { master: true } })).toMatchObject({ ok: false, status: 400 })
  })
})
