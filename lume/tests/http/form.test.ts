import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { formAnswer, formRedirect, formSameOrigin, readJsonOrForm, safeReturnTo } from '@/lib/http/form'

const Schema = z.object({ decision: z.enum(['approve', 'reject']) })
const fromForm = (f: URLSearchParams) => ({ decision: f.get('decision') })

const formReq = (body: string, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/x', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost', ...headers },
    body,
  })

describe('safeReturnTo', () => {
  it('keeps same-site paths under the allowed prefixes', () => {
    expect(safeReturnTo('/operator')).toBe('/operator')
    expect(safeReturnTo('/operator?vertical=abc')).toBe('/operator?vertical=abc')
    expect(safeReturnTo('/settings/verticals')).toBe('/settings/verticals')
  })
  it('falls back to /operator for anything else', () => {
    for (const bad of [null, '', 'https://evil.test/operator', '//evil.test/operator', '/\\evil', '/overview', 'operator', '/operatorx']) {
      expect(safeReturnTo(bad)).toBe('/operator')
    }
  })
})

describe('formSameOrigin', () => {
  it('accepts the request origin, refuses another', () => {
    expect(formSameOrigin(formReq(''))).toBe(true)
    expect(formSameOrigin(formReq('', { origin: 'https://evil.test' }))).toBe(false)
  })
  it('without Origin falls back to Sec-Fetch-Site', () => {
    const r = (site?: string) =>
      new Request('http://localhost/x', { method: 'POST', headers: site ? { 'sec-fetch-site': site } : {} })
    expect(formSameOrigin(r())).toBe(true)
    expect(formSameOrigin(r('same-origin'))).toBe(true)
    expect(formSameOrigin(r('cross-site'))).toBe(false)
  })
})

describe('readJsonOrForm', () => {
  it('JSON is unchanged', async () => {
    const r = await readJsonOrForm(
      new Request('http://localhost/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"decision":"approve"}' }),
      Schema,
      256,
      fromForm
    )
    expect(r).toEqual({ ok: true, data: { decision: 'approve' }, form: null })
  })

  it('a form post maps through fromForm and keeps return_to', async () => {
    const r = await readJsonOrForm(formReq('decision=reject&return_to=%2Foperator%3Fvertical%3Dv1'), Schema, 256, fromForm)
    expect(r.ok).toBe(true)
    if (!r.ok || !r.form) throw new Error('expected a form read')
    expect(r.data).toEqual({ decision: 'reject' })
    expect(r.form.returnTo).toBe('/operator?vertical=v1')
  })

  it('an invalid form body is a 303 back with flash_error', async () => {
    const r = await readJsonOrForm(formReq('decision=maybe'), Schema, 256, fromForm)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.response.status).toBe(303)
    expect(r.response.headers.get('location')).toBe('http://localhost/operator?flash_error=invalid_body')
  })

  it('a cross-origin form post is a 403', async () => {
    const r = await readJsonOrForm(formReq('decision=approve', { origin: 'https://evil.test' }), Schema, 256, fromForm)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.response.status).toBe(403)
  })
})

describe('formAnswer / formRedirect', () => {
  const req = formReq('')
  it('2xx → flash', async () => {
    const res = await formAnswer(req, '/operator', Response.json({ ok: true }), 'Approved')
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('http://localhost/operator?flash=Approved')
  })
  it('error → flash_error with the code, replacing an older flash', async () => {
    const res = await formAnswer(req, '/operator?flash=old', Response.json({ error: 'already_handled' }, { status: 409 }))
    expect(res.headers.get('location')).toBe('http://localhost/operator?flash_error=already_handled')
  })
  it('formRedirect sanitises the target', () => {
    expect(formRedirect(req, 'https://evil.test', { ok: 'x' }).headers.get('location')).toBe('http://localhost/operator?flash=x')
  })
})
