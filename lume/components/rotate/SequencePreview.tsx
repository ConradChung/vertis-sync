'use client'

import useSWR from 'swr'
import { ShimmerBar } from '@/components/overview/parts'
import { GlassCard } from '@/components/ui/glass-card'
import { fetchJson } from '@/hooks/fetcher'
import type { CampaignView } from '@/hooks/useCampaigns'
import type { SequenceStep } from '@/lib/adapters/instantly.map'

type SequenceAnswer = { configured: false } | { configured: true; steps: SequenceStep[] }

/** Right rail: the first three steps of the selected campaign's sequence (read-only). */
export function SequencePreview({ campaign }: { campaign: CampaignView | null }) {
  const isInstantly = campaign?.sender_type === 'instantly' && !!campaign.external_id
  const { data, error } = useSWR<SequenceAnswer>(
    isInstantly ? `/api/campaigns/${encodeURIComponent(campaign!.external_id!)}/sequence` : null,
    fetchJson
  )

  return (
    <GlassCard className="gap-3 px-[18px]" role="region" aria-label="Sequence preview">
      <div>
        <h2 className="text-[13px] font-semibold text-fg">Sequence</h2>
        <p className="truncate text-[12px] text-fg-46">{campaign ? campaign.name : 'Select a campaign card to preview its emails.'}</p>
      </div>
      {!campaign ? null : !isInstantly ? (
        <p className="text-[12px] text-fg-46">
          {campaign.sender_type === 'gmail' ? 'Sent from Gmail by hand — template not connected yet.' : 'Not connected yet.'}
        </p>
      ) : error ? (
        <p className="text-[12px] text-amber">Couldn&apos;t load the sequence from Instantly.</p>
      ) : !data ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <ShimmerBar className="h-4 w-2/3" />
          <ShimmerBar className="h-16 w-full" />
        </div>
      ) : !data.configured ? (
        <p className="text-[12px] text-fg-46">Instantly is not configured.</p>
      ) : data.steps.length === 0 ? (
        <p className="text-[12px] text-fg-46">This campaign has no sequence yet.</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {data.steps.map((s) => (
            <li key={s.step} className="rounded-[12px] border border-line bg-white/[.02] p-3">
              <div className="mb-1 flex items-center justify-between text-[11px] text-fg-46">
                <span>Step {s.step}</span>
                <span>{s.step === 1 ? 'Day 0' : `+${s.delayDays} day${s.delayDays === 1 ? '' : 's'}`}{s.variants > 1 ? ` · ${s.variants} variants` : ''}</span>
              </div>
              <div className="text-[12px] font-medium text-fg">{s.subject || <span className="text-fg-46">(same thread)</span>}</div>
              <p className="mt-1 line-clamp-4 text-[12px] whitespace-pre-line text-fg-70">{s.body}</p>
            </li>
          ))}
        </ol>
      )}
    </GlassCard>
  )
}
