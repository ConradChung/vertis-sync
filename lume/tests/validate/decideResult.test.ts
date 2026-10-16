import { describe, expect, it } from 'vitest'
import { clientOutcome, decideHttp } from '@/lib/validate/decideResult'

const ok = (claimed: boolean | null) => ({ ok: true as const, claimed, action: 'deny', target_id: 'x' })

describe('decideHttp', () => {
  it('claimed true → 200', () => expect(decideHttp(ok(true))).toEqual({ status: 200, body: { ok: true, claimed: true } }))
  it('claimed null → 200 (not observable)', () =>
    expect(decideHttp(ok(null))).toEqual({ status: 200, body: { ok: true, claimed: null } }))
  it('claimed false → 409 already_handled', () =>
    expect(decideHttp(ok(false))).toEqual({ status: 409, body: { error: 'already_handled' } }))
  it('timeout → 202 pending (re-read, never failure)', () =>
    expect(decideHttp({ ok: false, status: 0, error: 'timeout' })).toEqual({ status: 202, body: { pending: true } }))
  it('entrypoint 400 → 400', () =>
    expect(decideHttp({ ok: false, status: 400, error: 'bad callback_data' })).toEqual({ status: 400, body: { error: 'bad_callback_data' } }))
  it('not configured → 503', () =>
    expect(decideHttp({ ok: false, status: 0, error: 'pipeline entrypoint not configured' })).toEqual({
      status: 503,
      body: { error: 'pipeline_not_configured' },
    }))
  it('other failures → 502 generic, no upstream text', () => {
    const r = decideHttp({ ok: false, status: 500, error: 'stack trace with secrets' })
    expect(r).toEqual({ status: 502, body: { error: 'pipeline_error' } })
  })
})

describe('clientOutcome', () => {
  it('maps statuses', () => {
    expect(clientOutcome(200, { ok: true, claimed: true })).toBe('done')
    expect(clientOutcome(200, { ok: true, claimed: null })).toBe('sent')
    expect(clientOutcome(409, { error: 'already_handled' })).toBe('already_handled')
    expect(clientOutcome(202, { pending: true })).toBe('pending')
    expect(clientOutcome(502, { error: 'pipeline_error' })).toBe('error')
    expect(clientOutcome(504, null)).toBe('pending') // gateway timeout: still re-read
  })
})
