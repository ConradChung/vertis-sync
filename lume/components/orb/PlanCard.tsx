'use client'

import Link from 'next/link'
import { ShieldAlert } from 'lucide-react'
import type { ReplyCard } from '@/lib/inbox/model'

export interface PendingApproval {
  action_id: string
  deep_link: string
  summary: string | null
  tool: string
  /** send_reply: the reply card (lead, company, verdict, their message, draft, times). */
  reply?: ReplyCard
}

/**
 * What the agent asked to do that needs the owner's yes. The agent cannot
 * run these; each opens the action page (Confirm / Cancel), the same place
 * the Telegram ping links to.
 */
export function PlanCard({ approvals }: { approvals: PendingApproval[] }) {
  if (!approvals.length) return null
  return (
    <section aria-label="Waiting for your approval" className="rounded-panel border border-amber/40 bg-amber/8 p-3">
      <h3 className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-amber">
        <ShieldAlert className="size-3.5" /> Waiting for your approval
      </h3>
      <ul className="flex flex-col gap-2">
        {approvals.map((a) => (
          <li key={a.action_id} className="flex items-center justify-between gap-3 text-[13px]">
            <span className="min-w-0 flex-1 whitespace-pre-line text-fg-70">
              <span className="font-mono text-[11px] text-fg-46">{a.tool}</span>
              <br />
              {a.summary ?? 'Review this action'}
            </span>
            <Link
              href={a.deep_link}
              className="shrink-0 rounded-control bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring"
            >
              Review
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
