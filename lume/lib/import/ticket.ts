import 'server-only'
import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Upload ticket for the signed CSV upload: `<exp>.<hex>` where `exp` is a
 * Unix-ms expiry and `hex` is HMAC-SHA256(`path|exp`) under
 * `LUME_INTERNAL_SECRET`. `/api/import/csv/sign` issues it with the path it
 * chose; `/api/import/csv` accepts only a path it can verify, within
 * `UPLOAD_TICKET_TTL_MS`, so a caller cannot point an ingest at an arbitrary
 * object or replay an old ticket.
 */

export const LUME_UPLOAD_PATH = /^lume\/[0-9a-f-]{36}\.csv$/
export const UPLOAD_TICKET_TTL_MS = 15 * 60 * 1000

function secret(): string {
  const s = process.env.LUME_INTERNAL_SECRET
  if (!s) throw new Error('LUME_INTERNAL_SECRET not set')
  return s
}

const mac = (path: string, exp: number) => createHmac('sha256', secret()).update(`${path}|${exp}`).digest('hex')

export function uploadTicket(path: string, now: number = Date.now()): string {
  const exp = now + UPLOAD_TICKET_TTL_MS
  return `${exp}.${mac(path, exp)}`
}

export function verifyUploadTicket(path: string, ticket: unknown, now: number = Date.now()): boolean {
  if (typeof ticket !== 'string') return false
  const m = /^(\d{1,15})\.([0-9a-f]{64})$/.exec(ticket)
  if (!m) return false
  const exp = Number(m[1])
  if (!Number.isSafeInteger(exp) || now > exp) return false
  const expected = Buffer.from(mac(path, exp), 'hex')
  const given = Buffer.from(m[2], 'hex')
  return expected.length === given.length && timingSafeEqual(expected, given)
}
