'use client'

import { AnimatedNumber } from '@/components/ui/animated-number'
import { GlassCard } from '@/components/ui/glass-card'
import { NotConnected, SectionTitle, ShimmerBar } from '@/components/overview/parts'
import { campaignStatusText, isProblemStatus } from '@/lib/adapters/instantly.map'
import type { CampaignTableRow, InstantlyState } from '@/lib/campaigns/types'
import { cn } from '@/lib/utils'
import { ReplyModeSelect } from '@/components/campaigns/ReplyModeSelect'
import type { ReplyMode } from '@/lib/inbox/replyMode'

const n = (v: number | null) => (v === null ? '—' : <AnimatedNumber value={v} />)
const rate = (r: number | null) => (r === null ? '—' : <AnimatedNumber value={r < 10 ? r : Math.round(r)} decimals={r < 10 ? 1 : 0} suffix="%" />)

const FAMILY: Record<CampaignTableRow['family'], string> = {
  kaspen: 'bg-violet/15 text-violet-soft',
  recruiter: 'bg-cyan/15 text-cyan',
  muse: 'bg-amber/15 text-amber',
  other: 'bg-white/8 text-fg-46',
}

const STATUS_DOT: Record<string, string> = {
  active: 'bg-green',
  paused: 'bg-amber',
  completed: 'bg-fg-24',
  draft: 'bg-fg-24',
}

export function relTime(iso: string | null, now = Date.now()): string {
  if (!iso) return '—'
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (!Number.isFinite(s)) return '—'
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86_400)}d ago`
}

export function CampaignTable({
  rows,
  instantly,
  selectedKey,
  onSelect,
  replyMode,
}: {
  rows: CampaignTableRow[] | undefined
  instantly: InstantlyState | undefined
  selectedKey: string | null
  onSelect: (row: CampaignTableRow) => void
  /** The per-campaign reply approval mode column (Instantly campaigns only). */
  replyMode?: { modeOf: (id: string) => ReplyMode; canChange: boolean; onChange: (id: string, mode: ReplyMode) => Promise<boolean> | void }
}) {
  return (
    <GlassCard className="gap-0 py-0" aria-label="Campaigns">
      <SectionTitle title="All campaigns">
        {instantly === 'not_configured' && <NotConnected className="text-[11px]" />}
        {instantly === 'error' && <span className="text-amber">Instantly unreachable — showing registry only</span>}
      </SectionTitle>
      {!rows ? (
        <div className="space-y-3 px-[18px] pt-2 pb-6" aria-hidden>
          {[0, 1, 2].map((i) => (
            <ShimmerBar key={i} className="h-5 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="px-[18px] py-6 text-[13px] text-fg-46">No campaigns yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-[13px]">
            <thead className="text-[11px] tracking-wide text-fg-46 uppercase">
              <tr className="border-b border-white/8">
                <th className="px-[18px] py-2 font-medium">Campaign</th>
                <th className="px-2 py-2 font-medium">Status</th>
                <th className="px-2 py-2 text-right font-medium">Sent</th>
                <th className="px-2 py-2 text-right font-medium">Replies</th>
                <th className="px-2 py-2 text-right font-medium">Reply rate</th>
                <th className="px-2 py-2 text-right font-medium">Interested</th>
                <th className="px-2 py-2 text-right font-medium">Last activity</th>
                {replyMode && <th className="px-[18px] py-2 font-medium">Reply approval</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.key}
                  onClick={() => onSelect(r)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onSelect(r)
                    }
                  }}
                  tabIndex={0}
                  aria-selected={selectedKey === r.key}
                  className={cn(
                    'cursor-pointer border-b border-white/8 last:border-b-0 hover:bg-white/4 focus-visible:bg-white/6 focus-visible:outline-none',
                    selectedKey === r.key && 'bg-accent'
                  )}
                >
                  <td className="px-[18px] py-[10px]">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className={cn('shrink-0 rounded-full px-2 py-px text-[10px] font-medium capitalize', FAMILY[r.family])}>
                        {r.family}
                      </span>
                      <span className="truncate font-medium text-fg" title={r.name}>
                        {r.name}
                      </span>
                      <span className="shrink-0 text-[11px] text-fg-24">{r.sender_type}</span>
                    </div>
                  </td>
                  <td className="px-2 py-[10px]">
                    {isProblemStatus(r.status) ? (
                      <span
                        className="inline-flex items-center gap-1.5 rounded-full bg-red/15 px-2 py-0.5 text-[12px] whitespace-nowrap text-red"
                        title="Instantly has stopped this campaign from sending"
                      >
                        <span className="size-1.5 rounded-full bg-red" />
                        {campaignStatusText(r.status)}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-[12px] text-fg-46 capitalize">
                        <span className={cn('size-1.5 rounded-full', STATUS_DOT[r.status] ?? 'bg-fg-24')} />
                        {campaignStatusText(r.status)}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-[10px] text-right font-mono tabular-nums">{n(r.sent)}</td>
                  <td className="px-2 py-[10px] text-right font-mono tabular-nums">{n(r.replies)}</td>
                  <td className="px-2 py-[10px] text-right font-mono tabular-nums">{rate(r.reply_rate)}</td>
                  <td className="px-2 py-[10px] text-right font-mono tabular-nums">{n(r.opportunities)}</td>
                  <td className="px-2 py-[10px] text-right text-[12px] text-fg-46">{relTime(r.last_activity)}</td>
                  {replyMode && (
                    <td className="px-[18px] py-[10px]">
                      {r.instantly_id ? (
                        <ReplyModeSelect
                          campaignId={r.instantly_id}
                          campaignName={r.name}
                          mode={replyMode.modeOf(r.instantly_id)}
                          canChange={replyMode.canChange}
                          onChange={replyMode.onChange}
                        />
                      ) : (
                        <span className="text-[12px] text-fg-24">—</span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </GlassCard>
  )
}
