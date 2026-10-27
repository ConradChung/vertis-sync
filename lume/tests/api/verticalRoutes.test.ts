import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getClaims: async () => ({ data: { claims: { sub: 'owner-id', email: 'owner@example.com' } } }) } }),
}))

const s = vi.hoisted(() => ({
  listVerticals: vi.fn(),
  createVertical: vi.fn(),
  updateVertical: vi.fn(),
  archiveVertical: vi.fn(),
  getVertical: vi.fn(),
  listOperators: vi.fn(),
  createOperatorKey: vi.fn(),
  revokeOperator: vi.fn(),
}))
const sess = vi.hoisted(() => ({ currentOperator: vi.fn() }))
vi.mock('@/lib/operators/session', () => sess)
vi.mock('@/lib/operators/store', async () => {
  class DuplicateVerticalNameError extends Error {}
  class DefaultVerticalConflictError extends Error {}
  return { ...s, DuplicateVerticalNameError, DefaultVerticalConflictError }
})

import { GET as vGET, POST as vPOST } from '@/app/api/verticals/route'
import { PATCH as vPATCH } from '@/app/api/verticals/[id]/route'
import { GET as oGET, POST as oPOST } from '@/app/api/operators/route'
import { POST as revokePOST } from '@/app/api/operators/[id]/revoke/route'
import { DuplicateVerticalNameError } from '@/lib/operators/store'

const VID = '3941b73f-c74e-4cc5-9766-f0140e6ad9c9'
const OID = '9b2f4c1e-0d3a-4e5b-8c7d-6e5f4a3b2c1d'
const req = (url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${url}`, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    headers: { 'content-type': 'application/json', ...headers },
  })
const params = (id: string) => ({ params: Promise.resolve({ id }) })

beforeEach(() => {
  for (const f of Object.values(s)) f.mockReset()
  sess.currentOperator.mockReset()
  sess.currentOperator.mockResolvedValue(null)
  process.env.LUME_ALLOWED_EMAIL = 'owner@example.com'
  vi.stubEnv('LUME_INTERNAL_SECRET', 'internal-secret')
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('/api/verticals', () => {
  it('GET lists; ?archived=1 includes archived', async () => {
    s.listVerticals.mockResolvedValue([{ id: VID }])
    expect(await (await vGET(req('/api/verticals'))).json()).toEqual({ verticals: [{ id: VID }] })
    await vGET(req('/api/verticals?archived=1'))
    expect(s.listVerticals).toHaveBeenLastCalledWith({ includeArchived: true })
  })

  it('POST creates (the agent bearer may: create_vertical is low)', async () => {
    s.createVertical.mockResolvedValue({ id: VID, name: 'Dentists' })
    const res = await vPOST(req('/api/verticals', 'POST', { name: 'Dentists', scopes: ['campaign'], campaign_ids: ['abc-1'] }, { authorization: 'Bearer internal-secret' }))
    expect(res.status).toBe(201)
    expect(s.createVertical).toHaveBeenCalledWith({ name: 'Dentists', scopes: ['campaign'], campaign_ids: ['abc-1'] })
  })

  it('POST 409 on a duplicate name; 400 on a bad scope', async () => {
    s.createVertical.mockRejectedValue(new DuplicateVerticalNameError('x'))
    expect((await vPOST(req('/api/verticals', 'POST', { name: 'Dup' }))).status).toBe(409)
    expect((await vPOST(req('/api/verticals', 'POST', { name: 'X', scopes: ['everything'] }))).status).toBe(400)
  })

  it('PATCH edits or archives; 404 when gone', async () => {
    s.updateVertical.mockResolvedValue({ id: VID, name: 'New' })
    expect((await vPATCH(req(`/api/verticals/${VID}`, 'PATCH', { name: 'New', is_default: false }), params(VID))).status).toBe(200)
    expect(s.updateVertical).toHaveBeenCalledWith(VID, { name: 'New', is_default: false })
    s.archiveVertical.mockResolvedValue(true)
    expect(await (await vPATCH(req(`/api/verticals/${VID}`, 'PATCH', { archived: true }), params(VID))).json()).toEqual({ archived: true })
    s.updateVertical.mockResolvedValue(null)
    expect((await vPATCH(req(`/api/verticals/${VID}`, 'PATCH', { name: 'x' }), params(VID))).status).toBe(404)
    expect((await vPATCH(req(`/api/verticals/${VID}`, 'PATCH', {}), params(VID))).status).toBe(400)
  })
})

describe('/api/operators', () => {
  it('GET lists keys (a bot may view)', async () => {
    s.listOperators.mockResolvedValue([{ id: OID, label: 'Roofers bot' }])
    const res = await oGET(req('/api/operators', 'GET', undefined, { cookie: 'lume_op=whatever' }))
    expect(res.status).toBe(200)
    expect(s.listOperators).toHaveBeenCalledWith({ includeRevoked: true })
  })

  it('POST mints a vertical key: the sign-in link is in this response only, no-store', async () => {
    s.getVertical.mockResolvedValue({ id: VID, archived_at: null })
    s.createOperatorKey.mockResolvedValue({ operator: { id: OID, label: 'Roofers bot' }, rawKey: 'RAWKEY_abc' })
    const res = await oPOST(req('/api/operators', 'POST', { vertical_id: VID, label: 'Roofers bot' }))
    expect(res.status).toBe(201)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ operator: { id: OID, label: 'Roofers bot' }, sign_in_url: 'http://localhost/auth/operator?k=RAWKEY_abc' })
    expect(s.createOperatorKey).toHaveBeenCalledWith({ verticalId: VID, label: 'Roofers bot' })
  })

  it('POST mints a master key', async () => {
    s.createOperatorKey.mockResolvedValue({ operator: { id: OID }, rawKey: 'K' })
    await oPOST(req('/api/operators', 'POST', { master: true, label: 'Master' }))
    expect(s.createOperatorKey).toHaveBeenCalledWith({ master: true, label: 'Master' })
  })

  it('a Grok Bot (lume_op cookie) and the agent bearer can neither mint nor revoke', async () => {
    const asBot = { cookie: 'lume_op=anything' }
    expect((await oPOST(req('/api/operators', 'POST', { master: true, label: 'x' }, asBot))).status).toBe(403)
    expect((await revokePOST(req(`/api/operators/${OID}/revoke`, 'POST', {}, asBot), params(OID))).status).toBe(403)
    const bearer = { authorization: 'Bearer internal-secret' }
    expect((await oPOST(req('/api/operators', 'POST', { master: true, label: 'x' }, bearer))).status).toBe(403)
    expect((await revokePOST(req(`/api/operators/${OID}/revoke`, 'POST', {}, bearer), params(OID))).status).toBe(403)
    expect(s.createOperatorKey).not.toHaveBeenCalled()
    expect(s.revokeOperator).not.toHaveBeenCalled()
  })

  it('404 for an archived vertical; revoke works for the owner', async () => {
    s.getVertical.mockResolvedValue({ id: VID, archived_at: '2026-10-01' })
    expect((await oPOST(req('/api/operators', 'POST', { vertical_id: VID, label: 'x' }))).status).toBe(404)
    s.revokeOperator.mockResolvedValue(true)
    expect(await (await revokePOST(req(`/api/operators/${OID}/revoke`, 'POST', {}), params(OID))).json()).toEqual({ ok: true, revoked: true })
  })
})

describe('verticals: master-only for Grok Bots', () => {
  it('a vertical bot may list but not create or change a vertical', async () => {
    sess.currentOperator.mockResolvedValue({ id: OID, is_master: false, vertical_id: VID })
    s.listVerticals.mockResolvedValue([])
    expect((await vGET(req('/api/verticals'))).status).toBe(200)
    const created = await vPOST(req('/api/verticals', 'POST', { name: 'X' }))
    expect(created.status).toBe(403)
    expect(await created.json()).toMatchObject({ error: 'master_only', message: expect.stringContaining('only the master bot or owner') })
    expect((await vPATCH(req(`/api/verticals/${VID}`, 'PATCH', { name: 'Y' }), params(VID))).status).toBe(403)
    expect(s.createVertical).not.toHaveBeenCalled()
    expect(s.updateVertical).not.toHaveBeenCalled()
  })
  it('the master bot may', async () => {
    sess.currentOperator.mockResolvedValue({ id: OID, is_master: true, vertical_id: null })
    s.createVertical.mockResolvedValue({ id: VID })
    expect((await vPOST(req('/api/verticals', 'POST', { name: 'X' }))).status).toBe(201)
  })
})
