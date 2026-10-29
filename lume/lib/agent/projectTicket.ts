import 'server-only'
import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Upload ticket for a project file: `<exp>.<hex>`, hex = HMAC-SHA256 of
 * `agent-project-upload|<path>|<exp>` under LUME_INTERNAL_SECRET. The purpose
 * prefix keeps it from ever verifying as (or being verified by) another
 * upload ticket signed with the same secret, such as the CSV import's.
 */
const PURPOSE = 'agent-project-upload'
export const PROJECT_TICKET_TTL_MS = 15 * 60 * 1000

function secret(): string {
  const s = process.env.LUME_INTERNAL_SECRET
  if (!s) throw new Error('LUME_INTERNAL_SECRET not set')
  return s
}

const mac = (path: string, exp: number) => createHmac('sha256', secret()).update(`${PURPOSE}|${path}|${exp}`).digest('hex')

export function projectUploadTicket(path: string, now: number = Date.now()): string {
  const exp = now + PROJECT_TICKET_TTL_MS
  return `${exp}.${mac(path, exp)}`
}

export function verifyProjectUploadTicket(path: string, ticket: unknown, now: number = Date.now()): boolean {
  if (typeof ticket !== 'string') return false
  const m = /^(\d{1,15})\.([0-9a-f]{64})$/.exec(ticket)
  if (!m) return false
  const exp = Number(m[1])
  if (!Number.isSafeInteger(exp) || now > exp) return false
  const expected = Buffer.from(mac(path, exp), 'hex')
  const given = Buffer.from(m[2], 'hex')
  return expected.length === given.length && timingSafeEqual(expected, given)
}
