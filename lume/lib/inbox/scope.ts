import 'server-only'
import { NextResponse } from 'next/server'
import { currentOperator } from '@/lib/operators/session'
import { getVertical } from '@/lib/operators/store'
import type { Operator } from '@/lib/operators/types'

/**
 * Who is calling an inbox route and which campaigns they may touch.
 *
 *  - the agent's internal bearer, the owner, or the master Grok Bot: every
 *    campaign (`all`);
 *  - a vertical Grok Bot (owner session + `lume_op` cookie): only its
 *    vertical's `campaign_ids`. A bot whose vertical is gone or archived gets
 *    none.
 *
 * Like every operator guard (lib/operators/guard.ts) this is a policy line
 * for well-behaved bots, not a security boundary: a bot holds an owner
 * session.
 */

export type InboxScope =
  | { all: true; operator: Operator | null }
  | { all: false; operator: Operator; verticalId: string | null; campaignIds: string[] }

export async function inboxScope(req: Request, auth: { via: 'session' | 'internal' }): Promise<InboxScope> {
  if (auth.via !== 'session') return { all: true, operator: null }
  const op = await currentOperator(req)
  if (!op || op.is_master) return { all: true, operator: op }
  const v = op.vertical_id ? await getVertical(op.vertical_id) : null
  const campaignIds = v && !v.archived_at ? v.campaign_ids : []
  return { all: false, operator: op, verticalId: op.vertical_id, campaignIds }
}

/** May this scope touch the campaign? A missing campaign is allowed only for the full scope. */
export function campaignAllowed(scope: InboxScope, campaignId: string | null | undefined): boolean {
  if (scope.all) return true
  return !!campaignId && scope.campaignIds.includes(campaignId)
}

/** Who did it, for payloads and the CRM: `owner`, `agent`, or `operator:<id>`. */
export function actorOf(scope: InboxScope, via: 'session' | 'internal'): string {
  if (scope.operator) return `operator:${scope.operator.id}`
  return via === 'internal' ? 'agent' : 'owner'
}

/** A scope refusal or an input problem, with the status the route answers. */
export class InboxError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string) {
    super(code)
    this.name = 'InboxError'
    this.status = status
    this.code = code
  }
}

export const outOfScope = () => new InboxError(403, 'campaign_out_of_scope')

export function inboxErrorResponse(err: InboxError): NextResponse {
  return NextResponse.json({ error: err.code }, { status: err.status })
}
