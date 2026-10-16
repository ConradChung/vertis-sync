'use client'

import { Button } from '@/components/ui/button'
import { GlassCard } from '@/components/ui/glass-card'
import { AgentActivity } from '@/components/overview/AgentActivity'
import { CampaignStrip, CampaignStripSkeleton } from '@/components/overview/CampaignStrip'
import { InboxHealth } from '@/components/overview/InboxHealth'
import { KpiTiles, KpiTilesSkeleton } from '@/components/overview/KpiTiles'
import { NextRuns } from '@/components/overview/NextRuns'
import { FeedSkeleton, ReplyFeed } from '@/components/overview/ReplyFeed'
import { ShimmerBar } from '@/components/overview/parts'
import type { OverviewInstantly, OverviewPayload } from '@/lib/overview/types'

/**
 * The Overview bento grid, data in via props so the page (SWR) and fixtures
 * render it the same way. `data` is the database half; `instantly` arrives
 * separately and each Instantly-backed card shows its own loading state.
 */
export function OverviewView({
  data,
  error,
  onRetry,
  instantly,
  instantlyError,
  onRetryInstantly,
}: {
  data: OverviewPayload | undefined
  error?: unknown
  onRetry?: () => void
  instantly?: OverviewInstantly
  instantlyError?: unknown
  onRetryInstantly?: () => void
}) {
  if (!data && error) {
    return (
      <GlassCard className="flex-row items-center justify-between px-[18px]" role="alert">
        <span className="text-[13px] text-fg-70">Couldn&apos;t load the overview.</span>
        <Button size="sm" variant="secondary" onClick={onRetry}>
          Retry
        </Button>
      </GlassCard>
    )
  }
  if (!data) return <OverviewSkeleton />

  const instantlyFailed = !instantly && instantlyError != null
  const campaigns = instantly?.campaigns
  const campaignNames = Object.fromEntries((campaigns ?? []).map((c) => [c.id, c.name]))

  return (
    <div className="flex flex-col gap-4">
      {error != null && (
        <p className="flex items-center gap-3 text-[12px] text-amber" role="status">
          Couldn&apos;t refresh — showing the last data.
          <button type="button" onClick={onRetry} className="text-violet-soft hover:text-fg">
            Retry
          </button>
        </p>
      )}
      <KpiTiles data={data} instantly={instantly} instantlyFailed={instantlyFailed} />
      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <ReplyFeed events={data.reply_feed} campaignNames={campaignNames} />
        <div className="grid content-start gap-4">
          <CampaignStrip campaigns={campaigns} failed={instantlyFailed} onRetry={onRetryInstantly} />
          <AgentActivity events={data.agent_activity} />
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-[1.2fr_.8fr]">
        <InboxHealth instantly={instantly} failed={instantlyFailed} />
        <NextRuns scheduled={data.scheduled_jobs} />
      </div>
    </div>
  )
}

export function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading overview">
      <KpiTilesSkeleton />
      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <FeedSkeleton />
        <CampaignStripSkeleton />
      </div>
      <div className="grid gap-4 lg:grid-cols-[1.2fr_.8fr]">
        {[0, 1].map((i) => (
          <GlassCard key={i} className="gap-3 px-[18px]" aria-hidden>
            <ShimmerBar className="h-3 w-28" />
            <ShimmerBar className="h-3 w-full" />
            <ShimmerBar className="h-3 w-5/6" />
            <ShimmerBar className="h-3 w-2/3" />
          </GlassCard>
        ))}
      </div>
    </div>
  )
}
