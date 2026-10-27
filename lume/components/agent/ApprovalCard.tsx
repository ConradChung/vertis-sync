'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ShieldAlert, Zap } from 'lucide-react'
import type { PendingApproval } from '@/components/orb/PlanCard'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import type { StoredApproval } from '@/lib/agent/history'
import { cn } from '@/lib/utils'
import { OneTimeLink } from '@/components/operator/OneTimeLink'

/** An approval as the chat holds it: the run's state, plus the row's live status after a reload. */
export interface ChatApproval extends PendingApproval {
  state?: StoredApproval['state']
  /** pending_actions.status when the conversation loaded (null: the row is gone). */
  status?: string | null
}

/** What the owner decided in a card, and how it came out (feeds the automatic follow-up turn). */
export interface ApprovalDecision {
  action_id: string
  tool: string
  summary: string | null
  decision: 'approve' | 'reject'
  /** The row's status after the decision (or the status someone else left it in). */
  status: string
  error: string | null
  /** 409 already_handled: Telegram, the action page or another tab decided it first; `decision` was not applied. */
  elsewhere?: boolean
}

const LABEL: Record<string, string> = {
  approved: 'Approved',
  executing: 'Running',
  executed: 'Executed',
  rejected: 'Denied',
  failed: 'Failed',
  expired: 'Expired',
}
const label = (status: string | null | undefined) => (status ? (LABEL[status] ?? status) : 'Unavailable')

/**
 * The agent's high-risk requests, decided right in the chat. An awaiting one
 * gets Approve / Deny (the same owner-session POST /api/actions/<id>/decide a
 * click on the action page sends, so Telegram and Lume still race for one
 * row); skip mode's auto-runs show as a compact line. Each card reports its
 * decision through `onDecided` so the chat can tell the agent the outcome.
 */
export function ApprovalCard({ approvals, onDecided }: { approvals: ChatApproval[]; onDecided?: (d: ApprovalDecision) => void }) {
  if (!approvals.length) return null
  return (
    <ul className="flex flex-col gap-2" aria-label="Approvals">
      {approvals.map((a) => (
        <li key={a.action_id}>
          {a.state === 'auto_executed' || a.state === 'auto_failed' || a.state === 'handled_elsewhere' ? (
            <AutoLine a={a} />
          ) : (
            <Decision a={a} onDecided={onDecided} />
          )}
        </li>
      ))}
    </ul>
  )
}

function DetailsLink({ href }: { href: string }) {
  return (
    <Link href={href} className="shrink-0 text-[12px] text-fg-46 underline-offset-2 hover:text-fg hover:underline">
      Details
    </Link>
  )
}

/** Skip mode settled it without asking (or someone else got there first). */
function AutoLine({ a }: { a: ChatApproval }) {
  const failed = a.state === 'auto_failed'
  const text =
    a.state === 'handled_elsewhere'
      ? `Handled elsewhere: ${a.status ? label(a.status).toLowerCase() : 'already decided'}`
      : `${failed ? 'Failed' : 'Ran'} without asking (skip mode): ${a.summary ?? a.tool}`
  return (
    <div data-state={a.state} className={cn('flex items-start gap-2 text-[13px]', failed ? 'text-red' : 'text-fg-70')}>
      <Zap className={cn('mt-0.5 size-3.5 shrink-0', failed ? 'text-red' : 'text-amber')} />
      <span className="min-w-0 flex-1 whitespace-pre-line">{text}</span>
      <DetailsLink href={a.deep_link} />
    </div>
  )
}

type Settled = { text: string; tone: 'ok' | 'bad' | 'muted' }

function settledFrom(status: string): Settled {
  return { text: label(status), tone: status === 'failed' ? 'bad' : status === 'rejected' || status === 'expired' ? 'muted' : 'ok' }
}

/** Awaiting the owner: Approve / Deny until decided here, elsewhere, or before a reload. */
function Decision({ a, onDecided }: { a: ChatApproval; onDecided?: (d: ApprovalDecision) => void }) {
  const fromProp = (status: string | null | undefined) => (status === undefined || status === 'awaiting' ? null : settledFrom(status ?? ''))
  const [settled, setSettled] = useState<Settled | null>(() => fromProp(a.status))
  // Re-sync when a reload (or a parent) hands a new live status: adjust during render, not in an effect.
  const [seenStatus, setSeenStatus] = useState(a.status)
  if (seenStatus !== a.status) {
    setSeenStatus(a.status)
    setSettled(fromProp(a.status))
  }
  const [pending, setPending] = useState<'approve' | 'reject' | null>(null)
  const [error, setError] = useState<string | null>(null)
  // issue_operator_key: the sign-in link from the decide response, shown once.
  const [signIn, setSignIn] = useState<string | null>(null)
  // A decision that lands after this card unmounted (chat switched or reset) must not
  // send a follow-up into whatever conversation is on screen now.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const decide = async (decision: 'approve' | 'reject') => {
    setPending(decision)
    setError(null)
    const report = (status: string, err: string | null, elsewhere = false) => {
      if (mounted.current) onDecided?.({ action_id: a.action_id, tool: a.tool, summary: a.summary, decision, status, error: err, ...(elsewhere ? { elsewhere } : {}) })
    }
    try {
      const res = await fetch(`/api/actions/${a.action_id}/decide`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      })
      const body = (await res.json().catch(() => ({}))) as { status?: string; error?: string | null; sign_in_url?: string }
      if (typeof body.sign_in_url === 'string' && mounted.current) setSignIn(body.sign_in_url)
      if (res.status === 409 && body.error === 'already_handled') {
        const status = body.status ?? 'handled'
        setSettled({ text: `Already ${label(status).toLowerCase()} elsewhere`, tone: 'muted' })
        report(status, null, true)
        return
      }
      if (!res.ok) {
        setError(`Could not ${decision === 'approve' ? 'approve' : 'deny'} (${res.status}${body.error ? `: ${body.error}` : ''}).`)
        return
      }
      const status = decision === 'approve' ? (body.status ?? 'approved') : 'rejected'
      setSettled(settledFrom(status))
      report(status, body.error ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection lost.')
    } finally {
      setPending(null)
    }
  }

  return (
    <section
      aria-label={settled ? 'Approval' : 'Waiting for your approval'}
      className={cn('rounded-panel border p-3', settled ? 'border-line bg-white/4' : 'border-amber/40 bg-amber/8')}
    >
      <div className="flex items-start gap-3">
        <ShieldAlert className={cn('mt-0.5 size-3.5 shrink-0', settled ? 'text-fg-46' : 'text-amber')} />
        <div className="min-w-0 flex-1 text-[13px]">
          <span className="font-mono text-[11px] text-fg-46">{a.tool}</span>
          <p className="whitespace-pre-line text-fg-70">{a.summary ?? 'Review this action'}</p>
        </div>
        {settled && (
          <span
            className={cn(
              'shrink-0 rounded-full border px-2 py-0.5 text-[11.5px]',
              settled.tone === 'ok' && 'border-primary/40 text-positive',
              settled.tone === 'bad' && 'border-red/40 text-red',
              settled.tone === 'muted' && 'border-line text-fg-46'
            )}
          >
            {settled.text}
          </span>
        )}
      </div>
      <div className="mt-2.5 flex items-center gap-2 pl-6">
        {!settled && (
          <>
            <Button size="sm" onClick={() => void decide('approve')} disabled={!!pending}>
              {pending === 'approve' && <Spinner className="size-3" aria-hidden />}
              Approve
            </Button>
            <Button size="sm" variant="outline" onClick={() => void decide('reject')} disabled={!!pending}>
              {pending === 'reject' && <Spinner className="size-3" aria-hidden />}
              Deny
            </Button>
          </>
        )}
        <span className="ml-auto">
          <DetailsLink href={a.deep_link} />
        </span>
      </div>
      {error && (
        <p className="mt-2 pl-6 text-[12px] text-red" role="alert">
          {error}
        </p>
      )}
      {signIn && (
        <div className="pl-6">
          <OneTimeLink url={signIn} />
        </div>
      )}
    </section>
  )
}
