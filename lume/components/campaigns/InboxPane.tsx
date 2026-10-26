'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ActionNotice, noticeFrom, type NoticeState } from '@/components/campaigns/ActionNotice'
import { relTime } from '@/components/campaigns/CampaignTable'
import { NotConnected, ShimmerBar } from '@/components/overview/parts'
import { requestCampaignAction } from '@/hooks/useCampaignsScreen'
import type { InboxThread } from '@/lib/adapters/instantly.map'
import type { CampaignInboxResponse } from '@/lib/campaigns/types'
import { cn } from '@/lib/utils'

/**
 * Two-pane inbox over Instantly `GET /emails`. The reply box creates a
 * `send_reply` pending action; the email goes out only after confirmation.
 */
export function InboxPane({
  data,
  failed,
  campaignId,
  campaignName,
}: {
  data: CampaignInboxResponse | undefined
  failed: boolean
  campaignId: string
  campaignName: string
}) {
  const [selected, setSelected] = useState<string | null>(null)

  if (failed && !data) return <p className="py-6 text-[13px] text-fg-46" role="alert">Couldn&apos;t load the inbox.</p>
  if (!data) return <ShimmerBar className="h-[320px] w-full" />
  if (!data.configured) return <NotConnected className="py-6 text-[13px]" />
  if (data.threads.length === 0) return <p className="py-6 text-[13px] text-fg-46">No emails in this campaign yet.</p>

  const thread = data.threads.find((t) => t.thread_id === selected) ?? data.threads[0]

  return (
    <div className="grid min-h-[360px] gap-3 md:grid-cols-[260px_1fr]">
      <ul className="max-h-[480px] overflow-y-auto rounded-lg border border-white/8" aria-label="Threads">
        {data.threads.map((t) => (
          <li key={t.thread_id}>
            <button
              type="button"
              onClick={() => setSelected(t.thread_id)}
              aria-current={t.thread_id === thread.thread_id}
              className={cn(
                'w-full border-b border-white/8 px-3 py-2.5 text-left last:border-b-0 hover:bg-white/4',
                t.thread_id === thread.thread_id && 'bg-accent'
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className={cn('truncate text-[12px]', t.unread ? 'font-semibold text-fg' : 'text-fg')}>{t.lead ?? 'Unknown'}</span>
                <span className="shrink-0 text-[10px] text-fg-24">{relTime(t.last_at)}</span>
              </div>
              <p className="mt-0.5 truncate text-[11px] text-fg-46">{t.preview || t.subject || '—'}</p>
            </button>
          </li>
        ))}
      </ul>
      <ThreadView key={thread.thread_id} thread={thread} campaignId={campaignId} campaignName={campaignName} />
    </div>
  )
}

function ThreadView({ thread, campaignId, campaignName }: { thread: InboxThread; campaignId: string; campaignName: string }) {
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<NoticeState | null>(null)

  const submit = async () => {
    if (!thread.reply || !body.trim()) return
    setBusy(true)
    const subject = thread.reply.subject ?? thread.subject
    const r = await requestCampaignAction('send_reply', {
      campaign_id: campaignId,
      campaign_name: campaignName,
      eaccount: thread.reply.eaccount,
      reply_to_uuid: thread.reply.reply_to_uuid,
      body: body.trim(),
      subject: subject ? (/^re:/i.test(subject) ? subject : `Re: ${subject}`) : undefined,
      lead_email: thread.lead ?? undefined,
    })
    setBusy(false)
    setNotice(noticeFrom(r))
    if (r.ok) setBody('')
  }

  return (
    <div className="flex min-w-0 flex-col rounded-lg border border-white/8">
      <div className="border-b border-white/8 px-4 py-2.5">
        <p className="truncate text-[13px] font-medium text-fg">{thread.subject ?? '(no subject)'}</p>
        <p className="truncate text-[11px] text-fg-46">{thread.lead}</p>
      </div>
      <ol className="max-h-[340px] flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {thread.messages.map((m) => (
          <li key={m.id} className={cn('max-w-[85%] rounded-lg px-3 py-2 text-[12px]', m.direction === 'in' ? 'bg-white/6' : 'ml-auto bg-primary/15')}>
            <p className="mb-1 text-[10px] text-fg-46">
              {m.direction === 'in' ? m.from : `${m.eaccount ?? m.from ?? 'us'}`} · {relTime(m.at)}
            </p>
            <p className="break-words whitespace-pre-wrap text-fg">{m.text || '—'}</p>
          </li>
        ))}
      </ol>
      <div className="space-y-2 border-t border-white/8 p-3">
        {thread.reply ? (
          <>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={`Reply from ${thread.reply.eaccount}…`}
              rows={3}
              maxLength={20_000}
              aria-label="Reply"
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-fg-24">Sends only after you confirm (here or in Telegram).</span>
              <Button size="sm" onClick={submit} disabled={busy || !body.trim()}>
                {busy ? 'Requesting…' : 'Request send'}
              </Button>
            </div>
          </>
        ) : (
          <p className="text-[11px] text-fg-46">The lead hasn&apos;t replied in this thread — nothing to reply to.</p>
        )}
        {notice && <ActionNotice state={notice} onDismiss={() => setNotice(null)} />}
      </div>
    </div>
  )
}
