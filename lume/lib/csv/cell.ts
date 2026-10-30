const PHONE_OR_NUMBER = /^[+-]?\d[\d\s().\-/]*$/

/**
 * One cell of a CSV Lume hands out (Apollo export, influencer export, the
 * ingest CSV of an attached sheet): newlines flattened and the ends trimmed
 * (a leading tab or CR goes), a leading = + - @ (the OWASP formula-injection
 * set) prefixed with ', quoted when needed. Numbers are written as numbers.
 * A phone number or plain number (`+1 555 123 4567`, `-5`, `(555) 123-4567`:
 * digits, spaces and ( ) . - / only, no letters, no | or !) is left as is:
 * it cannot call a function or another program.
 */
export function csvCell(v: string | number | null | undefined): string {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ''
  let s = v === null || v === undefined ? '' : String(v)
  s = s.replace(/[\r\n]+/g, ' ').trim()
  if (/^[=+\-@\t\r]/.test(s) && !PHONE_OR_NUMBER.test(s)) s = `'${s}`
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
