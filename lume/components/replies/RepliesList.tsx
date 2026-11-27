'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { ExternalLink } from 'lucide-react'
import { ApprovalRow } from '@/components/approvals/ApprovalsList'
import { WaitChip } from '@/components/replies/WaitChip'
import { Surface } from '@/components/shell/Surface'
import { fetchJson } from '@/hooks/fetcher'
import { PENDING_KEY } from '@/hooks/usePendingCount'
import { useRealtimeInvalidate } from '@/hooks/useRealtimeInvalidate'
import { replyHref } from '@/lib/crm/client'
import { overdueCount, type LinkedinWaiting, type RepliesPayload, type ReplyWaiting } from '@/lib/replies/queue'

export const REPLIES_KEY = '/api/replies'

/**
 * `/replies`: pending approvals and unhandled positive replies in one list,
 * longest-waiting first, each with its waiting time (flagged past 5 minutes).
 * LinkedIn replies (SendPilot) have their drafted answer in the Slack thread.
 * Approvals keep their Confirm / Cancel (the same decide route as
 * `/actions/<id>`); a reply opens in Instantly or its deal. Nothing sends from here.
 * One full-width surface; rows sit in a grid (two columns on desktop, three
 * on very wide screens, one on a phone), set apart by space alone.
 */
export function RepliesList({ initial }: { initial: RepliesPayload }) {
  const { data, mutate } = useSWR<RepliesPayload>(REPLIES_KEY, fetchJson, {
    fallbackData: initial,
    refreshInterval: 30_000,
    revalidateOnFocus: true,
  })
  const { mutate: mutateGlobal } = useSWRConfig()
  useRealtimeInvalidate(() => void mutate(), { tables: ['pending_actions'] })
  // Timers tick once a minute.
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])

  const items = data?.items ?? []
  const replies = data?.replies ?? 0
  const approvals = data?.approvals ?? 0
  const late = overdueCount(items, now)

  return (
    <Surface aria-label="Waiting for you" role="region" className="gap-8">
      <p className="text-[13px] text-fg-46">
        {items.length === 0 ? (
          'Nothing waiting for you.'
        ) : (
          <>
            {replies} {replies === 1 ? 'reply' : 'replies'} · {approvals} {approvals === 1 ? 'approval' : 'approvals'}
            {late > 0 && <span className="text-fg"> · {late} over 5 minutes</span>}
          </>
        )}
      </p>
      {items.length > 0 && (
        <ul className="grid gap-x-16 gap-y-10 lg:grid-cols-2 2xl:grid-cols-3">
          {items.map((it) =>
            it.type === 'approval' ? (
              <ApprovalRow
                key={it.key}
                item={it.approval}
                now={now}
                wait={<WaitChip since={it.since} now={now} />}
                className=""
                onDecided={() => {
                  void mutate()
                  void mutateGlobal(PENDING_KEY)
                }}
              />
            ) : it.type === 'linkedin' ? (
              <LinkedinRow key={it.key} item={it.linkedin} now={now} />
            ) : (
              <ReplyRow key={it.key} reply={it.reply} now={now} />
            )
          )}
        </ul>
      )}
    </Surface>
  )
}

export function ReplyRow({ reply: r, now }: { reply: ReplyWaiting; now: Date | number }) {
  const who = r.lead_name ?? r.lead_email
  return (
    <li className="flex flex-col gap-2" data-kind="positive_reply">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <span className="eyebrow">Positive reply</span>
        <WaitChip since={r.received_at} now={now} />
      </div>
      <p className="text-[14px] leading-snug text-fg">
        {who}
        {r.company && <span className="text-fg-70"> · {r.company}</span>}
      </p>
      {r.untrusted_excerpt && <p className="line-clamp-3 text-[13px] leading-snug text-fg-70">“{r.untrusted_excerpt}”</p>}
      <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-[13px]">
        <span className="mr-auto truncate font-mono text-[12px] text-fg-46">{r.lead_email}</span>
        {r.draft_action_id && (
          <Link href={`/actions/${r.draft_action_id}`} className="text-fg hover:underline">
            Draft waiting for Confirm
          </Link>
        )}
        {r.deal_id && r.campaign_id && (
          <Link href={`/crm?campaign=${encodeURIComponent(r.campaign_id)}&deal=${r.deal_id}`} className="text-fg-70 hover:text-fg">
            Open deal
          </Link>
        )}
        <a href={replyHref('instantly', r.lead_email)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-fg-70 hover:text-fg">
          Open in Instantly <ExternalLink className="size-3" strokeWidth={1.75} aria-hidden />
        </a>
      </div>
    </li>
  )
}

const LABEL: Record<string, string> = { interested: 'Interested', question: 'Question', not_now: 'Not now' }

/** A LinkedIn reply: the drafted answer is in the Slack thread under the SendPilot notification. */
export function LinkedinRow({ item: r, now }: { item: LinkedinWaiting; now: Date | number }) {
  return (
    <li className="flex flex-col gap-2" data-kind="linkedin_reply">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <span className="eyebrow">LinkedIn · {LABEL[r.label] ?? r.label}</span>
        <WaitChip since={r.received_at} now={now} />
      </div>
      <p className="text-[14px] leading-snug text-fg">
        {r.name ?? 'LinkedIn reply'}
        {r.company && <span className="text-fg-70"> · {r.company}</span>}
      </p>
      {r.untrusted_excerpt && <p className="line-clamp-3 text-[13px] leading-snug text-fg-70">“{r.untrusted_excerpt}”</p>}
      <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-[13px]">
        <span className="mr-auto text-[12px] text-fg-46">{r.drafted ? 'Draft in the Slack thread' : 'No draft yet'}</span>
        <Link href={`/crm?campaign=linkedin&deal=${r.deal_id}`} className="text-fg-70 hover:text-fg">
          Open deal
        </Link>
        {r.linkedin_url && /^https:\/\/www\.linkedin\.com\//.test(r.linkedin_url) && (
          <a href={r.linkedin_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-fg-70 hover:text-fg">
            Open LinkedIn <ExternalLink className="size-3" strokeWidth={1.75} aria-hidden />
          </a>
        )}
      </div>
    </li>
  )
}
