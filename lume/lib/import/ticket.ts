import 'server-only'
import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Upload ticket for the signed CSV upload: HMAC-SHA256(path) under
 * `LUME_INTERNAL_SECRET`, hex. `/api/import/csv/sign` issues it with the
 * path it chose; `/api/import/csv` accepts only a path it can verify, so a
 * caller cannot point an ingest at an arbitrary object.
 */

export const LUME_UPLOAD_PATH = /^lume\/[0-9a-f-]{36}\.csv$/

function secret(): string {
  const s = process.env.LUME_INTERNAL_SECRET
  if (!s) throw new Error('LUME_INTERNAL_SECRET not set')
  return s
}

export function uploadTicket(path: string): string {
  return createHmac('sha256', secret()).update(path).digest('hex')
}

export function verifyUploadTicket(path: string, ticket: unknown): boolean {
  if (typeof ticket !== 'string' || !/^[0-9a-f]{64}$/.test(ticket)) return false
  const expected = Buffer.from(uploadTicket(path), 'hex')
  const given = Buffer.from(ticket, 'hex')
  return expected.length === given.length && timingSafeEqual(expected, given)
}
