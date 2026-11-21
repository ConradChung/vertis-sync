import { secretMatches } from '@/lib/auth/secret'

/** Shortest token we accept as configured: a short or empty env var fails closed. */
export const MIN_TOKEN_LENGTH = 32

/**
 * Phase 1 auth: one static bearer token (LUME_MCP_TOKEN), compared in constant
 * time. Runs before the MCP handler sees the request. Returns a 401 Response
 * to send, or null when the caller is allowed through.
 */
export function checkMcpAuth(req: Request, expected = process.env.LUME_MCP_TOKEN): Response | null {
  const header = req.headers.get('authorization') ?? ''
  const match = /^Bearer[ ]+(\S+)$/i.exec(header.trim())
  const presented = match?.[1]
  const configured = typeof expected === 'string' && expected.length >= MIN_TOKEN_LENGTH
  if (configured && secretMatches(presented, expected)) return null
  return new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="lume"' },
  })
}
