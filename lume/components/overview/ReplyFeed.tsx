'use client'

import { useEffect, useRef, useState } from 'react'
import { useReducedMotion } from 'motion/react'
import { AnimatedList } from '@/components/ui/animated-list'
import { BorderBeam } from '@/components/ui/border-beam'
import { GlassCard } from '@/components/ui/glass-card'
import { EmptyLine, SectionTitle, ShimmerBar, SrOnly, useNow } from '@/components/overview/parts'
import { timeAgo } from '@/lib/overview/compute'
import type { EventRow, Json } from '@/lib/db/types'
import { cn } from '@/lib/utils'

const KIND: Record<string, { label: string; color: string; chip: string }> = {
  reply: { label: 'Reply', color: '#22c55e', chip: 'bg-green/15 text-[#86efac]' },
  interested: { label: 'Interested', color: '#06b6d4', chip: 'bg-cyan/15 text-[#67e8f9]' },
  bounce: { label: 'Bounce', color: '#f43f5e', chip: 'bg-red/15 text-[#fda4af]' },
}

const str = (v: Json | undefined): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

function initials(email: string | null): string {
  if (!email) return '?'
  const local = email.split('@')[0].replace(/[^a-z0-9._-]/gi, '')
  const parts = local.split(/[._-]+/).filter(Boolean)
  const s = parts.length >= 2 ? parts[0][0] + parts[1][0] : local.slice(0, 2)
  return s.toUpperCase() || '?'
}

/** First line of the reply, if the webhook carried one. */
function snippet(p: EventRow['payload']): string | null {
  const t = str(p.reply_text_snippet) ?? str(p.reply_text) ?? str(p.text)
  if (!t) return null
  const first = t.split(/\r?\n/).find((l) => l.trim()) ?? ''
  return first.length > 160 ? `${first.slice(0, 157)}…` : first
}

/** Instantly unibox link: the webhook's own `unibox_url` when present, else a search for the lead. */
export function uniboxHref(ev: EventRow): string | null {
  if (ev.source !== 'instantly') return null
  const given = str(ev.payload.unibox_url)
  if (given && /^https:\/\/app\.instantly\.ai\//.test(given)) return given
  const email = ev.lead_email ?? str(ev.payload.lead_email)
  return email ? `https://app.instantly.ai/app/unibox?search=${encodeURIComponent(email)}` : 'https://app.instantly.ai/app/unibox'
}

function FeedItem({ ev, campaignName, now }: { ev: EventRow; campaignName: string | null; now: number }) {
  const kind = KIND[ev.type] ?? KIND.reply
  const href = uniboxHref(ev)
  const text = snippet(ev.payload)
  return (
    <article className="flex w-full gap-3 border-b border-white/8 py-[15px] last:border-b-0">
      <div className="grid size-[34px] flex-none place-items-center rounded-[11px] text-[11px] font-bold text-white" style={{ background: kind.color }} aria-hidden>
        {initials(ev.lead_email)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[13px] font-semibold text-fg">{ev.lead_email ?? 'Unknown lead'}</span>
            <span className={cn('shrink-0 rounded-[5px] px-[7px] py-[3px] text-[10px]', kind.chip)}>{kind.label}</span>
          </div>
          <time dateTime={ev.created_at} className="shrink-0 font-mono text-[10px] whitespace-nowrap text-fg-24" suppressHydrationWarning>
            {timeAgo(ev.created_at, now)}
          </time>
        </div>
        <div className="mt-[2px] text-[11px] text-fg-46">{ev.title}</div>
        {text && <p className="mt-2 mb-[7px] line-clamp-2 text-[13px] leading-[1.4] text-fg-70">{text}</p>}
        <div className="mt-2 flex items-center gap-2">
          {campaignName && <span className="max-w-[60%] truncate rounded-[5px] bg-accent px-[7px] py-[3px] text-[10px] text-violet-soft">{campaignName}</span>}
          {href && (
            <a href={href} target="_blank" rel="noreferrer" className="ml-auto text-[11px] text-fg-46 hover:text-fg">
              Open ↗
            </a>
          )}
        </div>
      </div>
    </article>
  )
}

const ANNOUNCE: Record<string, string> = { reply: 'New reply from', interested: 'New interested lead:', bounce: 'New bounce:' }

/**
 * One polite announcement when the newest event changes (not on first load,
 * not on every refetch). The list itself is not a live region.
 */
function useNewestAnnouncement(events: EventRow[]): string {
  const newest = events[0]
  const seen = useRef<number | null | undefined>(undefined)
  const [message, setMessage] = useState('')
  useEffect(() => {
    const id = newest?.id ?? null
    if (seen.current === undefined) {
      seen.current = id
      return
    }
    if (id !== null && id !== seen.current) {
      seen.current = id
      setMessage(`${ANNOUNCE[newest.type] ?? 'New event:'} ${newest.lead_email ?? 'unknown lead'}`)
    }
  }, [newest])
  return message
}

export function ReplyFeed({ events, campaignNames }: { events: EventRow[]; campaignNames: Record<string, string> }) {
  const reduce = useReducedMotion()
  const now = useNow(30_000)
  const announcement = useNewestAnnouncement(events)
  const nameFor = (ev: EventRow) =>
    (ev.campaign_id && campaignNames[ev.campaign_id]) || str(ev.payload.campaign_name) || (ev.campaign_id ? ev.campaign_id.slice(0, 8) : null)

  // AnimatedList reveals children oldest → newest and renders the newest on top.
  const items = events
    .slice(0, 12)
    .reverse()
    .map((ev) => <FeedItem key={ev.id} ev={ev} campaignName={nameFor(ev)} now={now} />)

  return (
    <GlassCard className="gap-0 py-0" aria-label="Live reply feed">
      {!reduce && <BorderBeam size={90} duration={9} colorFrom="#8b5cf6" colorTo="#22c55e" />}
      <SrOnly role="status" aria-live="polite">
        {announcement}
      </SrOnly>
      <SectionTitle title="Live reply feed">
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-[6px] rounded-full bg-green shadow-[0_0_8px_var(--green)]" aria-hidden />
          Replies · interested · bounces
        </span>
      </SectionTitle>
      {events.length === 0 ? (
        <EmptyLine text="No replies yet — they stream in as Instantly webhooks fire." action={{ label: 'Campaigns', href: '/campaigns' }} />
      ) : (
        <div className="px-[18px] pb-[10px]">
          {reduce ? (
            <div className="flex flex-col">{[...items].reverse()}</div>
          ) : (
            <AnimatedList delay={90} className="gap-0">
              {items}
            </AnimatedList>
          )}
        </div>
      )}
    </GlassCard>
  )
}

export function FeedSkeleton() {
  return (
    <GlassCard className="gap-0 py-0" aria-hidden>
      <SectionTitle title="Live reply feed" />
      <div className="space-y-5 px-[18px] pt-2 pb-6">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex gap-3">
            <ShimmerBar className="size-[34px] rounded-[11px]" />
            <div className="flex-1 space-y-2">
              <ShimmerBar className="h-3 w-1/3" />
              <ShimmerBar className="h-3 w-4/5" />
            </div>
          </div>
        ))}
      </div>
    </GlassCard>
  )
}
