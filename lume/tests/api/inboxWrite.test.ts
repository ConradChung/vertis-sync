import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InboxEmail } from '@/lib/inbox/model'

const h = vi.hoisted(() => ({
  requireOwner: vi.fn(),
  currentOperator: vi.fn(),
  getVertical: vi.fn(),
  getEmail: vi.fn(),
  applyLabel: vi.fn(),
  logBooking: vi.fn(),
  buildActionRequest: vi.fn(),
  createAction: vi.fn(),
  projectForVertical: vi.fn(),
  listItems: vi.fn(),
  getItemText: vi.fn(),
  appendProjectLine: vi.fn(),
}))
vi.mock('@/lib/auth/guards', async (orig) => ({ ...(await orig<typeof import('@/lib/auth/guards')>()), requireOwner: h.requireOwner }))
vi.mock('@/lib/operators/session', () => ({ currentOperator: h.currentOperator }))
vi.mock('@/lib/operators/store', () => ({ getVertical: h.getVertical }))
vi.mock('@/lib/adapters/instantlyEmails', () => ({ getEmail: h.getEmail, RateLimitedError: class extends Error {} }))
vi.mock('@/lib/inbox/label', () => ({ applyLabel: h.applyLabel, logBooking: h.logBooking }))
vi.mock('@/lib/actions/build', () => ({ buildActionRequest: h.buildActionRequest }))
vi.mock('@/lib/actions/create', () => ({
  createAction: h.createAction,
  DuplicateActionError: class DuplicateActionError extends Error {
    constructor(readonly existingId: string) {
      super('dup')
    }
  },
}))
vi.mock('@/lib/agent/projects', () => ({
  projectForVertical: h.projectForVertical,
  listItems: h.listItems,
  getItemText: h.getItemText,
  appendProjectLine: h.appendProjectLine,
  NotANoteError: class NotANoteError extends Error {},
  ProjectGoneError: class ProjectGoneError extends Error {},
}))

import { POST as labelPOST } from '@/app/api/inbox/label/route'
import { POST as bookingPOST } from '@/app/api/inbox/booking/route'
import { POST as draftPOST } from '@/app/api/inbox/draft/route'
import { GET as filesGET } from '@/app/api/inbox/files/route'
import { POST as rulePOST } from '@/app/api/inbox/files/rule/route'
import { DuplicateActionError } from '@/lib/actions/create'
import { NotANoteError } from '@/lib/agent/projects'
import { InboxError } from '@/lib/inbox/scope'

const C1 = '869d73b3-5bf3-4f1c-ba8c-43ac6d0f529d'
const C2 = '11111111-2222-4333-8444-555555555555'
const V = '0a4c1e2f-5b6d-4e7f-8a9b-0c1d2e3f4a5b'
const V2 = '2b1e6f0e-6c1d-4f43-9a6e-1f6f0c9f4a11'
const BOT = { id: 'op-1', vertical_id: V, is_master: false, label: 'Inbox bot', revoked_at: null }
const PROJECT = { id: '7db3d841-252c-4572-95ec-bc110727df8d', name: 'Scaleport inbox' }

const email = (o: Partial<InboxEmail> = {}): InboxEmail => ({
  id: 'e1', thread_id: 't1', direction: 'in', eaccount: 'f@ours.com', from: 'ada@acme.com', to: [], cc: [], lead: 'ada@acme.com',
  subject: 's', text: 't', at: null, campaign_id: C1, interest: 1, unread: false, auto_reply: false, ...o,
})

/** A Grok Bot's fetch() from its signed-in Lume tab: same Origin, Sec-Fetch-Site same-origin, a cookie session. */
const sameOrigin = { origin: 'http://localhost', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }
const post = (path: string, body: unknown, headers: Record<string, string> = sameOrigin) =>
  new Request(`http://localhost${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } })
const get = (path: string) => new Request(`http://localhost${path}`, { headers: sameOrigin })

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset()
  process.env.INSTANTLY_API_KEY = 'k'
  h.requireOwner.mockResolvedValue({ ok: true, via: 'session', user: { id: 'u', email: 'o@x' } })
  h.currentOperator.mockResolvedValue(null)
  h.getVertical.mockResolvedValue({ id: V, name: 'Scaleport', campaign_ids: [C1], scopes: ['replies'], is_default: false, archived_at: null })
  h.getEmail.mockResolvedValue(email())
  h.applyLabel.mockResolvedValue({ lead_email: 'ada@acme.com', campaign_id: C1, interest: 1, handled: false })
  h.logBooking.mockResolvedValue({ lead_email: 'ada@acme.com', campaign_id: C1, handled: true })
  h.buildActionRequest.mockImplementation(async ({ payload }: { payload: Record<string, unknown> }) => ({
    ok: true, kind: 'send_reply', payload: { ...payload, eaccount: 'f@ours.com', lead_email: 'ada@acme.com', company: 'Acme', summary: 'Send reply to ada@acme.com' },
  }))
  h.createAction.mockResolvedValue({ id: 'act-1' })
  h.projectForVertical.mockResolvedValue(PROJECT)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('same-origin rules for the bot\'s fetch()', () => {
  it('a same-origin fetch from the signed-in tab passes', async () => {
    expect((await labelPOST(post('/api/inbox/label', { reply_to_uuid: 'e1', category: 'interested' }))).status).toBe(200)
  })
  it('a cross-site page carrying the cookie is refused before anything runs', async () => {
    const res = await labelPOST(post('/api/inbox/label', { reply_to_uuid: 'e1', category: 'interested' }, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'cross_origin' })
    expect(h.applyLabel).not.toHaveBeenCalled()
  })
  it('Sec-Fetch-Site cross-site without Origin is refused too', async () => {
    expect((await draftPOST(post('/api/inbox/draft', { reply_to_uuid: 'e1', body: 'x' }, { 'sec-fetch-site': 'cross-site' }))).status).toBe(403)
    expect(h.createAction).not.toHaveBeenCalled()
  })
  it('the agent bearer (no browser headers) passes', async () => {
    h.requireOwner.mockResolvedValue({ ok: true, via: 'internal', user: null })
    expect((await labelPOST(post('/api/inbox/label', { reply_to_uuid: 'e1', category: 'ooo' }, { authorization: 'Bearer s' }))).status).toBe(200)
    expect(h.applyLabel).toHaveBeenCalledWith(expect.anything(), { all: true, operator: null }, 'agent')
  })
  it('forms are not accepted by the JSON routes', async () => {
    const res = await labelPOST(
      new Request('http://localhost/api/inbox/label', { method: 'POST', body: 'category=ooo', headers: { 'content-type': 'application/x-www-form-urlencoded', ...sameOrigin } })
    )
    expect(res.status).toBe(415)
  })
})

describe('POST /api/inbox/label', () => {
  it('validates with the shared schema', async () => {
    expect((await labelPOST(post('/api/inbox/label', { reply_to_uuid: 'e1' }))).status).toBe(400)
    expect((await labelPOST(post('/api/inbox/label', { reply_to_uuid: 'e1', category: 'maybe' }))).status).toBe(400)
    expect((await labelPOST(post('/api/inbox/label', { category: 'ooo' }))).status).toBe(400)
    expect(h.applyLabel).not.toHaveBeenCalled()
  })
  it('a Grok Bot labels in its own scope, attributed to it', async () => {
    h.currentOperator.mockResolvedValue(BOT)
    await labelPOST(post('/api/inbox/label', { reply_to_uuid: 'e1', category: 'interested' }))
    expect(h.applyLabel).toHaveBeenCalledWith(
      { reply_to_uuid: 'e1', category: 'interested' },
      expect.objectContaining({ all: false, campaignIds: [C1] }),
      'operator:op-1'
    )
  })
  it('a scope refusal from the service is its status', async () => {
    h.applyLabel.mockRejectedValue(new InboxError(403, 'campaign_out_of_scope'))
    const res = await labelPOST(post('/api/inbox/label', { reply_to_uuid: 'e1', category: 'interested' }))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'campaign_out_of_scope' })
  })
})

describe('POST /api/inbox/booking', () => {
  it('needs a time with an offset', async () => {
    expect((await bookingPOST(post('/api/inbox/booking', { reply_to_uuid: 'e1', time: 'tomorrow' }))).status).toBe(400)
    expect((await bookingPOST(post('/api/inbox/booking', { reply_to_uuid: 'e1', time: '2026-11-03T17:00:00' }))).status).toBe(400)
  })
  it('logs the booking', async () => {
    const res = await bookingPOST(post('/api/inbox/booking', { reply_to_uuid: 'e1', time: '2026-11-03T17:00:00-08:00', event_id: 'cal-1', event_link: 'https://calendly.com/x' }))
    expect(res.status).toBe(200)
    expect(h.logBooking).toHaveBeenCalledWith(expect.objectContaining({ event_id: 'cal-1' }), expect.anything(), 'owner')
  })
})

describe('POST /api/inbox/draft', () => {
  it('files a send_reply approval through the shared builder, attributed, with the reply card', async () => {
    h.currentOperator.mockResolvedValue(BOT)
    const res = await draftPOST(post('/api/inbox/draft', { reply_to_uuid: 'e1', body: 'Tuesday 10am PT?', verdict: 'GOOD', proposed_times: ['Tue 10:00 PT'], research_note: 'fits' }))
    expect(res.status).toBe(201)
    expect(h.buildActionRequest).toHaveBeenCalledWith({
      kind: 'send_reply',
      payload: { reply_to_uuid: 'e1', body: 'Tuesday 10am PT?', verdict: 'GOOD', proposed_times: ['Tue 10:00 PT'], research_note: 'fits', drafted_by: 'operator:op-1' },
    })
    expect(h.createAction).toHaveBeenCalledWith('send_reply', expect.objectContaining({ reply_to_uuid: 'e1' }), 'user')
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, action_id: 'act-1', deep_link: '/actions/act-1', reply: { company: 'Acme', draft: 'Tuesday 10am PT?' } })
  })
  it('another vertical\'s email: 403, nothing filed', async () => {
    h.currentOperator.mockResolvedValue(BOT)
    h.getEmail.mockResolvedValue(email({ campaign_id: C2 }))
    expect((await draftPOST(post('/api/inbox/draft', { reply_to_uuid: 'e1', body: 'x' }))).status).toBe(403)
    expect(h.buildActionRequest).not.toHaveBeenCalled()
  })
  it('unknown email: 404', async () => {
    h.getEmail.mockResolvedValue(null)
    expect((await draftPOST(post('/api/inbox/draft', { reply_to_uuid: 'e1', body: 'x' }))).status).toBe(404)
  })
  it('already drafted or replied: 409 with the existing action', async () => {
    h.createAction.mockRejectedValue(new DuplicateActionError('act-0'))
    const res = await draftPOST(post('/api/inbox/draft', { reply_to_uuid: 'e1', body: 'x' }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'already_drafted_or_replied', action_id: 'act-0' })
  })
  it('the builder refusing (an outbound email) is passed on', async () => {
    h.buildActionRequest.mockResolvedValue({ ok: false, status: 400, error: 'not_an_inbound_email' })
    const res = await draftPOST(post('/api/inbox/draft', { reply_to_uuid: 'e1', body: 'x' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'not_an_inbound_email' })
  })
  it('the caller cannot pass card facts (strict body)', async () => {
    expect((await draftPOST(post('/api/inbox/draft', { reply_to_uuid: 'e1', body: 'x', their_message: 'fake' }))).status).toBe(400)
  })
})

describe('GET /api/inbox/files and POST /api/inbox/files/rule', () => {
  const items = [
    { id: 'f2', name: 'voice-rules.md', kind: 'note', size_bytes: 20, readable: true, truncated: false, created_at: '2' },
    { id: 'f1', name: 'qualify-rules.md', kind: 'note', size_bytes: 10, readable: true, truncated: false, created_at: '1' },
  ]
  beforeEach(() => {
    h.listItems.mockResolvedValue(items)
    h.getItemText.mockResolvedValue({ ...items[0], text_content: '- Never say "circle back"' })
    h.appendProjectLine.mockResolvedValue({ id: 'f2', name: 'voice-rules.md', created: false, chars: 50 })
  })

  it('a vertical bot lists its own vertical\'s project', async () => {
    h.currentOperator.mockResolvedValue(BOT)
    const body = await (await filesGET(get('/api/inbox/files'))).json()
    expect(h.projectForVertical).toHaveBeenCalledWith(V)
    expect(body.project).toEqual(PROJECT)
    expect(body.files.map((f: { name: string }) => f.name)).toEqual(['voice-rules.md', 'qualify-rules.md'])
  })
  it('reads one file by name (case-insensitive)', async () => {
    h.currentOperator.mockResolvedValue(BOT)
    const body = await (await filesGET(get('/api/inbox/files?name=Voice-Rules.md'))).json()
    expect(h.getItemText).toHaveBeenCalledWith(PROJECT.id, 'f2')
    expect(body.file).toMatchObject({ name: 'voice-rules.md', text: '- Never say "circle back"', next_offset: null })
  })
  it('a missing file: 404; another vertical: 403; the owner must name a vertical', async () => {
    h.currentOperator.mockResolvedValue(BOT)
    expect((await filesGET(get('/api/inbox/files?name=nope.md'))).status).toBe(404)
    expect((await filesGET(get(`/api/inbox/files?vertical_id=${V2}`))).status).toBe(403)
    h.currentOperator.mockResolvedValue(null)
    expect(await (await filesGET(get('/api/inbox/files'))).json()).toEqual({ error: 'vertical_id_required' })
    expect((await filesGET(get(`/api/inbox/files?vertical_id=${V2}`))).status).toBe(200)
    expect(h.projectForVertical).toHaveBeenLastCalledWith(V2)
  })
  it('no linked project: 404', async () => {
    h.currentOperator.mockResolvedValue(BOT)
    h.projectForVertical.mockResolvedValue(null)
    expect(await (await filesGET(get('/api/inbox/files'))).json()).toEqual({ error: 'no_project_for_vertical' })
  })

  it('append-rule: one line to the named file in the vertical\'s project', async () => {
    h.currentOperator.mockResolvedValue(BOT)
    const res = await rulePOST(post('/api/inbox/files/rule', { file: 'voice-rules.md', rule: 'Sign off with "Conrad", never "Best".' }))
    expect(res.status).toBe(200)
    expect(h.appendProjectLine).toHaveBeenCalledWith(PROJECT.id, 'voice-rules.md', 'Sign off with "Conrad", never "Best".')
    expect(await res.json()).toMatchObject({ ok: true, file: { name: 'voice-rules.md', created: false } })
  })
  it('append-rule: a path is not a file name; an uploaded file is 409; cross-site is 403', async () => {
    h.currentOperator.mockResolvedValue(BOT)
    expect((await rulePOST(post('/api/inbox/files/rule', { file: '../x.md', rule: 'r' }))).status).toBe(400)
    h.appendProjectLine.mockRejectedValue(new NotANoteError())
    expect((await rulePOST(post('/api/inbox/files/rule', { file: 'qualify-rules.md', rule: 'r' }))).status).toBe(409)
    expect((await rulePOST(post('/api/inbox/files/rule', { file: 'a.md', rule: 'r' }, { origin: 'https://evil.example' }))).status).toBe(403)
  })
})
