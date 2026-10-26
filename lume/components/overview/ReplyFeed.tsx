'use client'

import { useEffect, useRef, useState } from 'react'
import { useReducedMotion } from 'motion/react'
import { AnimatedList } from '@/components/ui/animated-list'
import Link from 'next/link'
import { ArrowUpRight, Inbox } from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { GlassCard } from '@/components/ui/glass-card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SectionTitle, ShimmerBar, SrOnly, useNow } from '@/components/overview/parts'
import { timeAgo } from '@/lib/overview/compute'
import type { EventRow, Json } from '@/lib/db/types'
import { cn } from '@/lib/utils'

/** Replies and interested leads are signal (lime); bounces are destructive. */
const KIND: Record<string, { label: string; chip: string }> = {
  reply: { label: 'Reply', chip: 'bg-lime/10 text-lime' },
  interested: { label: 'Interested', chip: 'bg-lime/10 text-lime' },
  bounce: { label: 'Bounce', chip: 'bg-destructive/15 text-destructive' },
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
    <article className="flex w-full gap-3 border-b border-border py-4 last:border-b-0">
      <Avatar className="size-8 rounded-lg after:rounded-lg" aria-hidden>
        <AvatarFallback className="rounded-lg bg-white/10 font-mono text-[11px] font-medium text-foreground">{initials(ev.lead_email)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-mono text-sm text-foreground">{ev.lead_email ?? 'Unknown lead'}</span>
            <Badge className={cn('rounded-md', kind.chip)}>{kind.label}</Badge>
          </div>
          <time dateTime={ev.created_at} className="shrink-0 font-mono text-xs whitespace-nowrap text-white/25 tabular-nums" suppressHydrationWarning>
            {timeAgo(ev.created_at, now)}
          </time>
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">{ev.title}</div>
        {text && <p className="mt-2 line-clamp-2 text-sm leading-snug text-white/70">{text}</p>}
        <div className="mt-2 flex items-center gap-2">
          {campaignName && (
            <Badge variant="outline" className="max-w-[60%] rounded-md font-normal text-muted-foreground">
              <span className="truncate">{campaignName}</span>
            </Badge>
          )}
          {href && (
            <a href={href} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground">
              Open <ArrowUpRight size={14} strokeWidth={1.75} aria-hidden />
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
      <SrOnly role="status" aria-live="polite">
        {announcement}
      </SrOnly>
      <SectionTitle title="Live reply feed">
        <span className="flex items-center gap-1.5">
          <span className="relative inline-flex size-1.5" aria-hidden>
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-lime opacity-60 motion-reduce:hidden" />
            <span className="relative inline-flex size-1.5 rounded-full bg-lime" />
          </span>
          Replies · interested · bounces
        </span>
      </SectionTitle>
      {events.length === 0 ? (
        <Empty className="py-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Inbox size={16} strokeWidth={1.75} />
            </EmptyMedia>
            <EmptyTitle className="text-sm font-medium">No replies yet</EmptyTitle>
            <EmptyDescription>They stream in as Instantly webhooks fire.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Link href="/campaigns" className="text-xs text-violet-soft hover:underline">
              Campaigns →
            </Link>
          </EmptyContent>
        </Empty>
      ) : (
        <ScrollArea className="[&_[data-slot=scroll-area-viewport]]:max-h-[560px]">
          <div className="px-5 pb-2">
            {reduce ? (
              <div className="flex flex-col">{[...items].reverse()}</div>
            ) : (
              <AnimatedList delay={90} className="gap-0">
                {items}
              </AnimatedList>
            )}
          </div>
        </ScrollArea>
      )}
    </GlassCard>
  )
}

export function FeedSkeleton() {
  return (
    <GlassCard className="gap-0 py-0" aria-hidden>
      <SectionTitle title="Live reply feed" />
      <div className="space-y-5 px-5 pt-2 pb-6">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex gap-3">
            <ShimmerBar className="size-8 rounded-lg" />
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
