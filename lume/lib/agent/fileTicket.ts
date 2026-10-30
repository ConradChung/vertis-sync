import 'server-only'
import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Upload ticket for a chat spreadsheet: `<exp>.<hex>`, hex = HMAC-SHA256 of
 * `agent-chat-file-upload|<path>|<exp>` under LUME_INTERNAL_SECRET. The
 * purpose prefix keeps it from verifying as a project-file or CSV-import
 * ticket (same secret) and the other way round.
 */
const PURPOSE = 'agent-chat-file-upload'
export const FILE_TICKET_TTL_MS = 15 * 60 * 1000

function secret(): string {
  const s = process.env.LUME_INTERNAL_SECRET
  if (!s) throw new Error('LUME_INTERNAL_SECRET not set')
  return s
}

const mac = (path: string, exp: number) => createHmac('sha256', secret()).update(`${PURPOSE}|${path}|${exp}`).digest('hex')

export function fileUploadTicket(path: string, now: number = Date.now()): string {
  const exp = now + FILE_TICKET_TTL_MS
  return `${exp}.${mac(path, exp)}`
}

export function verifyFileUploadTicket(path: string, ticket: unknown, now: number = Date.now()): boolean {
  if (typeof ticket !== 'string') return false
  const m = /^(\d{1,15})\.([0-9a-f]{64})$/.exec(ticket)
  if (!m) return false
  const exp = Number(m[1])
  if (!Number.isSafeInteger(exp) || now > exp) return false
  const expected = Buffer.from(mac(path, exp), 'hex')
  const given = Buffer.from(m[2], 'hex')
  return expected.length === given.length && timingSafeEqual(expected, given)
}
