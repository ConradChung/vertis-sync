import { internalOrigin } from '@/lib/http/origin'
import { checkMcpAuth } from '@/lib/mcp/auth'
import { mcpContext } from '@/lib/mcp/context'
import { buildMcpHandler } from '@/lib/mcp/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const handler = buildMcpHandler()

/** The token check runs first; nothing else sees an unauthenticated request. */
async function guarded(req: Request): Promise<Response> {
  const denied = checkMcpAuth(req)
  if (denied) return denied
  // Gated confirms hand off to /api/actions/<id>/execute on this deployment.
  return mcpContext.run({ origin: internalOrigin(req) }, () => handler(req))
}

export { guarded as GET, guarded as POST, guarded as DELETE }
