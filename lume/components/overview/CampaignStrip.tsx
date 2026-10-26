'use client'

import { GlassCard } from '@/components/ui/glass-card'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyLine, HealthDot, SectionTitle, ShimmerBar, Spark, type Tone } from '@/components/overview/parts'
import type { CampaignStripItem, HealthLevel } from '@/lib/overview/types'

/** Campaign sends are a primary series in every state; health is carried by the dot. */
const SPARK_TONE: Record<HealthLevel, Tone> = { green: 'lime', amber: 'lime', red: 'lime', idle: 'lime' }

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
        <div className="flex items-center justify-between gap-3 px-5 py-6 text-sm text-muted-foreground" role="alert">
          <span>Couldn&apos;t load campaigns.</span>
          <Button size="sm" variant="secondary" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : campaigns.length === 0 ? (
        <EmptyLine text="No campaigns yet." action={{ label: 'Campaigns', href: '/campaigns' }} />
      ) : (
        <Table>
          <TableHeader className="bg-(--glass-fill)">
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-8 pl-5 text-xs font-normal text-muted-foreground">Campaign</TableHead>
              <TableHead className="h-8 text-right text-xs font-normal text-muted-foreground">Reply</TableHead>
              <TableHead className="h-8 w-20 pr-5 text-right text-xs font-normal text-muted-foreground">7d</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {campaigns.map((c) => (
              <TableRow key={`${c.sender}:${c.id}`} className="hover:bg-accent">
                <TableCell className="max-w-0 py-2.5 pl-5">
                  <div className="flex min-w-0 items-center gap-2">
                    <HealthDot level={c.health.level} reason={c.health.reason} />
                    <span className="truncate text-sm font-medium text-foreground" title={c.name}>
                      {c.name}
                    </span>
                  </div>
                  <div className="mt-0.5 truncate pl-3.5 text-xs text-muted-foreground">
                    {c.sender} · {c.status}
                    {c.sent !== null && <span className="font-mono tabular-nums"> · {c.sent.toLocaleString('en-US')} sent</span>}
                    {c.bounces_24h > 0 && <span className="font-mono text-destructive tabular-nums"> · {c.bounces_24h} bounces/24h</span>}
                  </div>
                </TableCell>
                <TableCell className={`py-2.5 text-right font-mono text-sm tabular-nums ${c.reply_rate === null ? 'text-white/25' : 'text-foreground'}`}>
                  {rate(c.reply_rate)}
                </TableCell>
                <TableCell className="w-20 py-2.5 pr-5">
                  {c.series.length > 1 ? (
                    <Spark data={c.series} tone={SPARK_TONE[c.health.level]} className="h-6" label={`${c.name} daily sends, last 7 days`} />
                  ) : (
                    <span className="block text-right text-xs text-white/25">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </GlassCard>
  )
}

export function CampaignStripSkeleton() {
  return (
    <GlassCard className="gap-0 py-0" aria-hidden>
      <SectionTitle title="Campaigns" />
      <div className="space-y-4 px-5 pt-2 pb-6">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-3">
            <ShimmerBar className="h-3 flex-1" />
            <ShimmerBar className="h-3 w-10" />
            <ShimmerBar className="h-6 w-16" />
          </div>
        ))}
      </div>
    </GlassCard>
  )
}
