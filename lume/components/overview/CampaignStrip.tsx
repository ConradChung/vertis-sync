'use client'

import { GlassCard } from '@/components/ui/glass-card'
import { EmptyLine, HealthDot, SectionTitle, ShimmerBar, Spark, type Tone } from '@/components/overview/parts'
import type { CampaignStripItem, HealthLevel } from '@/lib/overview/types'

const SPARK_TONE: Record<HealthLevel, Tone> = { green: 'green', amber: 'amber', red: 'red', idle: 'violet' }

const rate = (r: number | null) => (r === null ? '—' : `${r < 10 ? r.toFixed(1) : Math.round(r)}%`)

export function CampaignStrip({
  campaigns,
  failed = false,
  onRetry,
}: {
  /** undefined while `/api/overview/instantly` loads. */
  campaigns: CampaignStripItem[] | undefined
  failed?: boolean
  onRetry?: () => void
}) {
  if (!campaigns && !failed) return <CampaignStripSkeleton />
  return (
    <GlassCard className="gap-0 py-0" aria-label="Campaigns">
      <SectionTitle title="Campaigns">
        <span>reply rate · 7-day sends</span>
      </SectionTitle>
      {!campaigns ? (
        <div className="flex items-center justify-between gap-3 px-[18px] py-6 text-[13px] text-fg-46" role="alert">
          <span>Couldn&apos;t load campaigns.</span>
          <button type="button" onClick={onRetry} className="text-[12px] text-violet-soft hover:text-fg">
            Retry
          </button>
        </div>
      ) : campaigns.length === 0 ? (
        <EmptyLine text="No campaigns yet." action={{ label: 'Campaigns', href: '/campaigns' }} />
      ) : (
        <ul>
          {campaigns.map((c) => (
            <li key={`${c.sender}:${c.id}`} className="border-b border-white/8 px-[18px] py-[14px] last:border-b-0">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-[7px]">
                  <HealthDot level={c.health.level} reason={c.health.reason} />
                  <span className="truncate text-[13px] font-medium text-fg" title={c.name}>
                    {c.name}
                  </span>
                </div>
                <span className={`font-mono text-[17px] font-semibold tabular-nums ${c.reply_rate === null ? 'text-fg-24' : 'text-fg'}`}>
                  {rate(c.reply_rate)}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between gap-3 text-[11px] text-fg-46">
                <span className="truncate">
                  {c.sender} · {c.status}
                  {c.sent !== null && <span className="font-mono tabular-nums"> · {c.sent.toLocaleString('en-US')} sent</span>}
                </span>
                {c.bounces_24h > 0 && <span className="shrink-0 font-mono text-red tabular-nums">{c.bounces_24h} bounces/24h</span>}
              </div>
              {c.series.length > 1 ? (
                <Spark data={c.series} tone={SPARK_TONE[c.health.level]} className="mt-2 h-[26px]" label={`${c.name} daily sends, last 7 days`} />
              ) : (
                <p className="mt-2 text-[11px] text-fg-24">{c.health.reason}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </GlassCard>
  )
}

export function CampaignStripSkeleton() {
  return (
    <GlassCard className="gap-0 py-0" aria-hidden>
      <SectionTitle title="Campaigns" />
      <div className="space-y-5 px-[18px] pt-2 pb-6">
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-2">
            <ShimmerBar className="h-3 w-1/2" />
            <ShimmerBar className="h-[26px] w-full" />
          </div>
        ))}
      </div>
    </GlassCard>
  )
}
