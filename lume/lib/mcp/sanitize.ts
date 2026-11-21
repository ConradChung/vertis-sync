/**
 * Everything that leaves the MCP server (tool results, errors, audit rows)
 * goes through here. Two jobs: never let a secret out, and mark third-party
 * text (replies, lead fields, scraped posts) as untrusted data.
 */

const SECRET_ENV = /(KEY|SECRET|TOKEN|PASSWORD|PASS|DSN|PRIVATE)/i
const MIN_SECRET_LEN = 12

/** Token shapes that are secrets wherever they appear. */
const SECRET_PATTERNS: RegExp[] = [
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, // JWTs (Supabase keys)
  /\bsk-[A-Za-z0-9_-]{16,}/g, // Anthropic/OpenAI style
  /\bsb_(secret|publishable)_[A-Za-z0-9_-]{10,}/g, // Supabase new-style keys
  /\bapify_api_[A-Za-z0-9]{10,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g, // Telegram bot tokens
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
]

function secretEnvValues(env: Record<string, string | undefined>): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(env)) {
    if (v && v.length >= MIN_SECRET_LEN && SECRET_ENV.test(k)) out.push(v)
  }
  // Longest first so a value containing another is replaced whole.
  return out.sort((a, b) => b.length - a.length)
}

/** Replace any secret env value or token-shaped string with [redacted]. */
export function redact(text: string, env: Record<string, string | undefined> = process.env): string {
  let out = text
  for (const v of secretEnvValues(env)) {
    if (out.includes(v)) out = out.split(v).join('[redacted]')
  }
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]')
  return out
}

/** Clip to `max` characters, marking the cut. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + `… [+${text.length - max} chars]`
}

export type Untrusted = { untrusted: string } | null

/**
 * Third-party text (reply bodies, lead fields, scraped posts) is returned
 * inside `{ untrusted: "..." }` and clipped. The server instructions tell the
 * client to treat these values as data, never as instructions.
 */
export function untrusted(text: unknown, max = 500): Untrusted {
  if (text == null || text === '') return null
  const s = typeof text === 'string' ? text : JSON.stringify(text)
  return { untrusted: truncate(s.replace(/\s+/g, ' ').trim(), max) }
}

/** Known, safe-to-show error. Anything else becomes a generic message. */
export class McpUserError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpUserError'
  }
}

/**
 * The text a client sees for a failed call. Only McpUserError messages pass
 * through (redacted); everything else is generic, so a stack trace, SQL error
 * or env value never reaches the client.
 */
export function safeErrorMessage(err: unknown): string {
  if (err instanceof McpUserError) return redact(err.message).slice(0, 300)
  return 'Lume hit an internal error. Try again shortly; if it keeps failing, check the Lume logs.'
}

const DROP_KEYS = /(email|emails|leads|rows|body|text|html|token|secret|key|password)$/i

/**
 * Arguments as stored in the audit row: scalars kept (strings clipped to 80),
 * arrays reduced to their length, secret-ish or bulky keys dropped.
 */
export function sanitizeArgs(args: unknown, depth = 0): unknown {
  if (args == null || typeof args === 'number' || typeof args === 'boolean') return args
  if (typeof args === 'string') return redact(truncate(args, 80))
  if (Array.isArray(args)) return { count: args.length }
  if (typeof args === 'object' && depth < 2) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
      out[k] = DROP_KEYS.test(k) ? '[omitted]' : sanitizeArgs(v, depth + 1)
    }
    return out
  }
  return '[omitted]'
}
