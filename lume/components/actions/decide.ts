'use client'

import { toast } from 'sonner'

export type Decision = 'approve' | 'reject'

/**
 * Confirm / Cancel one pending action through `/api/actions/<id>/decide`
 * (the same claim a Telegram tap races for) and toast the outcome. Shared by
 * the plan card (`/actions/<id>`) and the Approvals list. Returns the one-time
 * sign-in link when the response carries one (issue_operator_key).
 */
export async function decideAction(id: string, decision: Decision): Promise<{ signInUrl: string | null }> {
  let signInUrl: string | null = null
  try {
    const res = await fetch(`/api/actions/${id}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision }),
    })
    const body = (await res.json().catch(() => ({}))) as { status?: string; error?: string | null; sign_in_url?: string }
    if (typeof body.sign_in_url === 'string') signInUrl = body.sign_in_url
    if (res.status === 409) toast.info('Already handled — someone decided this first')
    else if (!res.ok && res.status !== 202) toast.error(body.error ?? `Failed (${res.status})`)
    else if (decision === 'reject') toast.success('Cancelled')
    else if (res.status === 202) toast.info('Approved — still running')
    else if (body.status === 'failed') toast.error(`Failed: ${body.error ?? 'see details'}`)
    else toast.success('Done')
  } catch {
    toast.error('Network error')
  }
  return { signInUrl }
}
