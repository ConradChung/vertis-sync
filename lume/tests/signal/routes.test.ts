import { createHmac, randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const jobs: (() => Promise<unknown>)[] = []
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: () => Promise<unknown>) => jobs.push(fn) }))
const decide = vi.hoisted(() => ({ clientButton: vi.fn(), clientOpenEdit: vi.fn(), clientSaveEdit: vi.fn() }))
vi.mock('@/lib/slack/decide', () => decide)
const sd = vi.hoisted(() => ({ signalButton: vi.fn(), signalOpenEdit: vi.fn(), signalSaveEdit: vi.fn() }))
vi.mock('@/lib/slack/signalDecide', () => sd)
const alerts = vi.hoisted(() => ({ runSignalAlerts: vi.fn() }))
vi.mock('@/lib/signal/alerts', () => alerts)

import { POST as interactions } from '@/app/api/slack/interactions/route'
import { POST as signalCron } from '@/app/api/cron/signal-alerts/route'
import { parseInteraction } from '@/lib/slack/payloads'

const SECRET = 'sign-secret'
const UUID = '0b4c1f2e-7d3a-4b9e-8f6a-2c1d3e4f5a6b'
function signed(body: string) {
  const ts = Math.floor(Date.now() / 1000)
  const sig = `v0=${createHmac('sha256', SECRET).update(`v0:${ts}:${body}`).digest('hex')}`
  return new Request('https://x/api/slack/interactions', { method: 'POST', body, headers: { 'x-slack-request-timestamp': String(ts), 'x-slack-signature': sig } })
}
const form = (payload: unknown) => `payload=${encodeURIComponent(JSON.stringify(payload))}`
const button = (action_id: string, value: string) => ({
  type: 'block_actions', team: { id: 'T0AAA' }, user: { id: 'U0USER' }, trigger_id: 'trig', container: { channel_id: 'C0AAA', message_ts: '1.2' },
  actions: [{ action_id, value }],
})
const runJobs = async () => {
  for (const j of jobs.splice(0)) await j()
}

beforeEach(() => {
  vi.resetAllMocks()
  jobs.length = 0
  vi.stubEnv('SLACK_CLIENT_ID', 'cid')
  vi.stubEnv('SLACK_CLIENT_SECRET', 'csecret')
  vi.stubEnv('SLACK_SIGNING_SECRET', SECRET)
  vi.stubEnv('LUME_SLACK_TOKEN_KEY', randomBytes(32).toString('base64'))
  vi.stubEnv('LUME_HOOK_SECRET', 'hook-secret')
})
afterEach(() => vi.unstubAllEnvs())

describe('interactions router', () => {
  it('sends signal buttons to signalDecide', async () => {
    for (const [id, decision] of [['signal_approve', 'approve'], ['signal_skip', 'skip']] as const) {
      expect((await interactions(signed(form(button(id, '42'))))).status).toBe(200)
      await runJobs()
      expect(sd.signalButton).toHaveBeenLastCalledWith({ team: 'T0AAA', user: 'U0USER', channel: 'C0AAA' }, '1.2', 42, decision)
    }
    await interactions(signed(form(button('signal_edit', '42'))))
    await runJobs()
    expect(sd.signalOpenEdit).toHaveBeenCalledWith({ team: 'T0AAA', user: 'U0USER', channel: 'C0AAA' }, '1.2', 42, 'trig')
    expect(decide.clientButton).not.toHaveBeenCalled()
    expect(decide.clientOpenEdit).not.toHaveBeenCalled()
  })

  it('leaves existing lume_* actions on lib/slack/decide, unchanged', async () => {
    await interactions(signed(form(button('lume_approve', UUID))))
    await interactions(signed(form(button('lume_edit', UUID))))
    await runJobs()
    expect(decide.clientButton).toHaveBeenCalledWith({ team: 'T0AAA', user: 'U0USER', channel: 'C0AAA' }, '1.2', UUID, 'approve')
    expect(decide.clientOpenEdit).toHaveBeenCalledWith({ team: 'T0AAA', user: 'U0USER', channel: 'C0AAA' }, '1.2', UUID, 'trig')
    expect(sd.signalButton).not.toHaveBeenCalled()
    expect(sd.signalOpenEdit).not.toHaveBeenCalled()
    // The existing parse is untouched.
    expect(parseInteraction(form(button('lume_skip', UUID)))).toEqual({ kind: 'button', decision: 'skip', team: 'T0AAA', user: 'U0USER', channel: 'C0AAA', message_ts: '1.2', action_id: UUID, trigger_id: 'trig' })
    const sub = { type: 'view_submission', team: { id: 'T0AAA' }, user: { id: 'U0USER' }, view: { callback_id: 'lume_edit_submit', private_metadata: '7', state: { values: { lume_body: { body: { value: 'hi' } } } } } }
    expect(parseInteraction(form(sub))).toEqual({ kind: 'edit_submit', team: 'T0AAA', user: 'U0USER', post_id: 7, body: 'hi' })
  })

  it('ignores a signal action with a non-numeric value, and a lume action with a numeric one', () => {
    expect(parseInteraction(form(button('signal_approve', UUID)))).toBeNull()
    expect(parseInteraction(form(button('signal_approve', '0')))).toBeNull()
    expect(parseInteraction(form(button('lume_approve', '42')))).toBeNull()
  })

  it('routes the signal edit submit, and answers an over-long connection note synchronously', async () => {
    const values = (note: string) => ({ signal_dm: { value: { value: 'dm' } }, signal_connection_note: { value: { value: note } } })
    const sub = (note: string) => ({ type: 'view_submission', team: { id: 'T0AAA' }, user: { id: 'U0USER' }, view: { callback_id: 'signal_edit', private_metadata: '42', state: { values: values(note) } } })
    const bad = await interactions(signed(form(sub('x'.repeat(301)))))
    expect(await bad.json()).toMatchObject({ response_action: 'errors', errors: { signal_connection_note: expect.stringContaining('300') } })
    await runJobs()
    expect(sd.signalSaveEdit).not.toHaveBeenCalled()

    expect((await interactions(signed(form(sub('short note'))))).status).toBe(200)
    await runJobs()
    expect(sd.signalSaveEdit).toHaveBeenCalledWith({ team: 'T0AAA', user: 'U0USER' }, 42, { dm: 'dm', connection_note: 'short note', followup_dm: null, after_reply: null })
    expect(decide.clientSaveEdit).not.toHaveBeenCalled()
  })
})

describe('/api/cron/signal-alerts', () => {
  it('needs X-Lume-Hook-Secret', async () => {
    expect((await signalCron(new Request('https://x/api/cron/signal-alerts', { method: 'POST' }))).status).toBe(401)
    expect((await signalCron(new Request('https://x/api/cron/signal-alerts', { method: 'POST', headers: { 'X-Lume-Hook-Secret': 'nope' } }))).status).toBe(401)
    expect(alerts.runSignalAlerts).not.toHaveBeenCalled()
  })
  it('returns the summary', async () => {
    alerts.runSignalAlerts.mockResolvedValue({ ok: true, dry_run: true })
    const res = await signalCron(new Request('https://x/api/cron/signal-alerts', { method: 'POST', headers: { 'X-Lume-Hook-Secret': 'hook-secret' } }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, dry_run: true })
  })
})
