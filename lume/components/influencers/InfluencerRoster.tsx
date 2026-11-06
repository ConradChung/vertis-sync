'use client'

import Link from 'next/link'
import useSWR from 'swr'
import { toast } from 'sonner'
import { GlassCard } from '@/components/ui/glass-card'
import { SectionTitle, ShimmerBar } from '@/components/overview/parts'
import { fetchJson } from '@/hooks/fetcher'
import { sendJson } from '@/lib/validate/client'
import { ago } from '@/lib/import/format'
import type { InfluencerRow } from '@/lib/influencers/model'
import { cn } from '@/lib/utils'

/**
 * `/influencers`: the roster of actual influencers the reactions pipeline
 * mines — active toggle, the last run's numbers, notes. Candidate lists (names
 * waiting for the LinkedIn lookup and review) are sheets in Leads now; this
 * tab links to them.
 */

interface Batch {
  id: string
  name: string
  status: string
  counts?: Record<string, number>
  list_id: string | null
}

const fmt = new Intl.NumberFormat('en-US')
const usd = (v: number | string | null) => (v === null || v === undefined ? null : `$${(Number(v) || 0).toFixed(2)}`)

function lastRun(r: InfluencerRow): string {
  if (!r.last_ran_at) return 'Never run'
  const parts = [
    r.last_posts != null ? `${fmt.format(r.last_posts)} posts` : null,
    r.last_reactors != null ? `${fmt.format(r.last_reactors)} reactors` : null,
    r.last_leads != null ? `${fmt.format(r.last_leads)} leads${r.last_leads_700 != null ? ` (${fmt.format(r.last_leads_700)} at 700+)` : ''}` : null,
    usd(r.last_cost_usd),
  ].filter(Boolean)
  return parts.join(' · ')
}

export function InfluencerRoster() {
  const roster = useSWR<{ influencers: InfluencerRow[] }>('/api/influencers', fetchJson)
  const sheets = useSWR<{ batches: Batch[] }>('/api/influencers/candidates', fetchJson)

  const setActive = async (r: InfluencerRow, active: boolean) => {
    const res = await sendJson(`/api/influencers/${r.slug}`, { active }, { method: 'PATCH' })
    if (res.status !== 200) toast.error(`Couldn't ${active ? 'activate' : 'pause'} ${r.name}`)
    void roster.mutate()
  }

  return (
    <div className="flex flex-col gap-4">
      <GlassCard className="gap-0 py-0" aria-label="Influencers">
        <SectionTitle title="Influencers">
          <span>{roster.data ? `${roster.data.influencers.filter((r) => r.active).length} active of ${roster.data.influencers.length}` : ''}</span>
        </SectionTitle>
        {roster.error && !roster.data ? (
          <p className="px-[18px] pb-4 text-[12px] text-amber" role="alert">
            Couldn&apos;t load the influencers.
          </p>
        ) : !roster.data ? (
          <ShimmerBar className="mx-[18px] mb-4 h-16" />
        ) : roster.data.influencers.length === 0 ? (
          <p className="px-[18px] pb-4 text-[12px] text-fg-46">No influencers yet. Approve candidates in their sheet in Leads, or ask the agent to add one.</p>
        ) : (
          <div className="overflow-x-auto px-[18px] pb-[18px]">
            <table className="w-full min-w-[720px] text-left text-[12px]">
              <thead className="text-fg-46">
                <tr>
                  <th className="py-1.5 pr-3 font-normal">Active</th>
                  <th className="py-1.5 pr-3 font-normal">Influencer</th>
                  <th className="py-1.5 pr-3 font-normal">Last run</th>
                  <th className="py-1.5 font-normal">Notes</th>
                </tr>
              </thead>
              <tbody>
                {roster.data.influencers.map((r) => (
                  <tr key={r.id} className="border-t border-line align-top">
                    <td className="py-2 pr-3">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={r.active}
                        aria-label={`${r.name} active`}
                        onClick={() => void setActive(r, !r.active)}
                        className={cn('relative h-4 w-7 rounded-full transition-colors', r.active ? 'bg-primary' : 'bg-white/15')}
                      >
                        <span className={cn('absolute top-0.5 size-3 rounded-full bg-white transition-all', r.active ? 'left-3.5' : 'left-0.5')} />
                      </button>
                    </td>
                    <td className="py-2 pr-3">
                      <a href={r.linkedin_url} target="_blank" rel="noopener noreferrer" className="text-fg hover:text-violet-soft">
                        {r.name}
                      </a>
                      <div className="text-[11px] text-fg-46">
                        {r.lookback_days} days back · ≤ {fmt.format(r.max_reactions_per_post)} reactions / post
                      </div>
                    </td>
                    <td className="py-2 pr-3 text-fg-70">
                      {lastRun(r)}
                      {r.last_ran_at && <div className="text-[11px] text-fg-46">{ago(r.last_ran_at)}</div>}
                    </td>
                    <td className="max-w-72 py-2 text-fg-70">{r.notes ?? <span className="text-fg-24">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </GlassCard>

      <GlassCard className="gap-2 px-[18px] py-4" aria-label="Candidate sheets">
        <p className="text-[13px] font-medium text-fg">Candidate lists</p>
        <p className="text-[12px] text-fg-46">Names waiting for the LinkedIn lookup and your review are sheets in Leads (Import → Lead lists). Approving there makes inactive influencers here.</p>
        {(sheets.data?.batches ?? []).length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {sheets.data!.batches.map((b) => (
              <li key={b.id}>
                {b.list_id ? (
                  <Link href={`/import/leads?list=${b.list_id}`} className="rounded-full border border-line px-3 py-1 text-[12px] text-fg-70 hover:text-fg">
                    {b.name}
                  </Link>
                ) : (
                  <span className="text-[12px] text-fg-46">{b.name}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </GlassCard>
    </div>
  )
}
