import { NextResponse } from 'next/server'
import { readBodyCapped } from '@/lib/http/readBody'
import { requestOrigin } from '@/lib/http/origin'
import type { FlashError, FlashOk } from '@/lib/http/flash'

/**
 * Plain HTML form posts for the routes the `/operator` check-in page uses
 * (Grok Bot reads and clicks a no-JS page). A route reads its body with
 * `readJsonOrForm`: JSON stays exactly as before; an
 * `application/x-www-form-urlencoded` post is mapped to the same shape by the
 * route's `fromForm` and validated by the same zod schema. A form post must
 * be same-origin (Origin, else Sec-Fetch-Site), and is answered with a 303
 * back to a same-site `return_to` path (default `/operator`) carrying a
 * `flash` / `flash_error` CODE (lib/http/flash.ts) instead of JSON
 * (`formAnswer`); the page maps codes to fixed text.
 */

export const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded'

export function isFormPost(req: Request): boolean {
  return (req.headers.get('content-type') ?? '').toLowerCase().startsWith(FORM_CONTENT_TYPE)
}

/** Same-origin check for a cookie-authenticated form post. */
export function formSameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin')
  if (origin && origin !== 'null') {
    const allowed = new Set([new URL(req.url).origin, requestOrigin(req)])
    return allowed.has(origin.replace(/\/+$/, ''))
  }
  const site = req.headers.get('sec-fetch-site')
  return !site || site === 'same-origin' || site === 'none'
}

/** Where a form post may send the browser back to: a same-site path under an allowed prefix. */
const RETURN_PREFIXES = ['/operator', '/settings', '/validate', '/actions']

export function safeReturnTo(raw: string | null | undefined): string {
  const v = (raw ?? '').trim()
  if (!v.startsWith('/') || v.startsWith('//') || v.includes('\\')) return '/operator'
  try {
    const u = new URL(v, 'http://x')
    if (u.origin !== 'http://x') return '/operator'
    if (!RETURN_PREFIXES.some((p) => u.pathname === p || u.pathname.startsWith(`${p}/`))) return '/operator'
    return `${u.pathname}${u.search}`
  } catch {
    return '/operator'
  }
}

export type BodyRead<T> =
  | { ok: true; data: T; form: null }
  | { ok: true; data: T; form: { returnTo: string; fields: URLSearchParams } }
  | { ok: false; response: Response }

interface Schema<T> {
  safeParse(v: unknown): { success: true; data: T } | { success: false }
}

/**
 * JSON (as `parseJsonBody`) or a same-origin urlencoded form. Errors on a
 * form post are already 303 redirects with `flash_error`.
 */
export async function readJsonOrForm<T>(
  req: Request,
  schema: Schema<T>,
  maxBytes: number,
  fromForm: (fields: URLSearchParams) => unknown
): Promise<BodyRead<T>> {
  const form = isFormPost(req)
  if (form && !formSameOrigin(req)) return { ok: false, response: NextResponse.json({ error: 'cross_origin' }, { status: 403 }) }
  const body = await readBodyCapped(req, maxBytes)
  if (!body.ok) {
    return {
      ok: false,
      response: form ? formRedirect(req, '/operator', { error: 'too_large' }) : NextResponse.json({ error: 'too_large' }, { status: 413 }),
    }
  }
  if (form) {
    const fields = new URLSearchParams(body.text)
    const returnTo = safeReturnTo(fields.get('return_to'))
    const parsed = schema.safeParse(fromForm(fields))
    if (!parsed.success) return { ok: false, response: formRedirect(req, returnTo, { error: 'invalid_body' }) }
    return { ok: true, data: parsed.data, form: { returnTo, fields } }
  }
  let raw: unknown
  try {
    raw = JSON.parse(body.text)
  } catch {
    return { ok: false, response: NextResponse.json({ error: 'invalid_json' }, { status: 400 }) }
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) return { ok: false, response: NextResponse.json({ error: 'invalid_body' }, { status: 400 }) }
  return { ok: true, data: parsed.data, form: null }
}

/** 303 to `returnTo` with `flash` (ok) or `flash_error`, replacing any earlier flash. */
export function formRedirect(req: Request, returnTo: string, flash: { ok?: FlashOk; error?: FlashError | string }): Response {
  const url = new URL(safeReturnTo(returnTo), requestOrigin(req))
  url.searchParams.delete('flash')
  url.searchParams.delete('flash_error')
  if (flash.error) url.searchParams.set('flash_error', flash.error.slice(0, 64))
  else if (flash.ok) url.searchParams.set('flash', flash.ok)
  return NextResponse.redirect(url, 303)
}

/**
 * Turn a route's JSON answer into the form redirect: a 2xx → `flash=<okCode>`;
 * anything else → `flash_error=<the body's error code>` (or `http_<status>`).
 */
export async function formAnswer(req: Request, returnTo: string, res: Response, okCode: FlashOk = 'done'): Promise<Response> {
  if (res.status >= 200 && res.status < 300) return formRedirect(req, returnTo, { ok: okCode })
  let code = `http_${res.status}`
  try {
    const j = (await res.clone().json()) as { error?: unknown }
    if (typeof j?.error === 'string' && j.error) code = j.error
  } catch {
    // not JSON
  }
  return formRedirect(req, returnTo, { error: code })
}
