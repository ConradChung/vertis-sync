'use client'

import { GlassCard } from '@/components/ui/glass-card'
import { EmptyLine, HealthDot, NotConnected, SectionTitle } from '@/components/overview/parts'
import { accountHealth } from '@/lib/overview/compute'
import type { InstantlySummary } from '@/lib/overview/types'

const label = (s: string) => s.replace(/_/g, ' ')

export function InboxHealth({ instantly }: { instantly: InstantlySummary }) {
  const accounts = instantly.configured && !instantly.error ? instantly.accounts : undefined

  return (
    <GlassCard className="gap-0 py-0" aria-label="Inbox health">
      <SectionTitle title="Inbox health">{accounts && <span className="font-mono tabular-nums">{accounts.length} accounts</span>}</SectionTitle>
      {!instantly.configured ? (
        <div className="px-[18px] pt-1 pb-6">
          <NotConnected />
        </div>
      ) : instantly.error || !accounts ? (
        <div className="px-[18px] pt-1 pb-6">
          <NotConnected>Instantly accounts unavailable — retrying</NotConnected>
        </div>
      ) : accounts.length === 0 ? (
        <EmptyLine text="No sending accounts in Instantly." action={{ label: 'Instantly accounts', href: 'https://app.instantly.ai/app/accounts', external: true }} />
      ) : (
        <div className="surface m-[10px] mt-1 overflow-auto rounded-[12px]">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="text-left text-[10px] font-medium tracking-[0.7px] text-fg-24 uppercase">
                <th className="border-b border-line px-[14px] py-[10px] font-medium">Account</th>
                <th className="border-b border-line px-[14px] py-[10px] font-medium">Status</th>
                <th className="border-b border-line px-[14px] py-[10px] text-right font-medium">Warmup</th>
                <th className="border-b border-line px-[14px] py-[10px] text-right font-medium">Daily cap</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => {
                const h = accountHealth(a)
                return (
                  <tr key={a.email} className="text-fg-70">
                    <td className="max-w-[220px] truncate border-b border-white/6 px-[14px] py-[11px] font-mono text-[11px]" title={a.email}>
                      {a.email}
                    </td>
                    <td className="border-b border-white/6 px-[14px] py-[11px] whitespace-nowrap">
                      <span className="inline-flex items-center gap-[7px]">
                        <HealthDot level={h.level} reason={h.reason} />
                        {label(a.warmup_status === 'active' ? a.status : a.warmup_status)}
                      </span>
                    </td>
                    <td className="border-b border-white/6 px-[14px] py-[11px] text-right font-mono tabular-nums">{a.warmup_score === null ? '—' : `${a.warmup_score}%`}</td>
                    <td className="border-b border-white/6 px-[14px] py-[11px] text-right font-mono tabular-nums">{a.daily_limit ?? '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </GlassCard>
  )
}
