'use client'

import Link from 'next/link'
import useSWR from 'swr'
import { ExternalLink } from 'lucide-react'
import { Surface } from '@/components/shell/Surface'
import { fetchJson } from '@/hooks/fetcher'
import { shortDate } from '@/lib/crm/pilot'
import type { InfluencerRow } from '@/lib/influencers/model'
import { ownerDate } from '@/lib/time/owner'

type Row = InfluencerRow & { zero_yield?: boolean; warning?: string | null }
const nf = new Intl.NumberFormat('en-US')
const num = (v: number | null | undefined) => (v === null || v === undefined ? '—' : nf.format(v))
const usd = (v: number | string | null | undefined) => (v === null || v === undefined ? '—' : '$' + Number(v).toFixed(2))

/**
 * Influencers inside Signals: the people whose post reactions are scraped,
 * with what each one's last run found. Read only (the same
 * `GET /api/influencers` the agent uses); runs are still started from the
 * agent or Telegram and wait for a tap. Their verified reactors are the
 * "Influencer reaction" accounts in the inbox.
 */
export function InfluencersList() {
  const { data, error } = useSWR<{ influencers: Row[] }>('/api/influencers', fetchJson, { revalidateOnFocus: false })
  const rows = data?.influencers ?? []
  return (
    <Surface className="gap-8">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 text-[13px]">
        <span className="text-fg-46">{data ? rows.length + ' influencers' : error ? 'Could not load influencers. Refresh to try again.' : 'Loading…'}</span>
        <Link href="/signals?source=influencer" className="ml-auto text-fg hover:underline">
          Their reactors in the inbox
        </Link>
        <Link href="/import/leads" className="text-fg-70 hover:text-fg">
          Candidate lists
        </Link>
      </div>
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-separate border-spacing-y-3 text-left text-[13px]">
            <thead className="text-[12px] text-fg-46">
              <tr>
                <th scope="col" className="pr-4 font-normal">
                  Influencer
                </th>
                <th scope="col" className="pr-4 font-normal">
                  Last run
                </th>
                <th scope="col" className="pr-4 text-right font-normal">
                  Posts
                </th>
                <th scope="col" className="pr-4 text-right font-normal">
                  Reactors
                </th>
                <th scope="col" className="pr-4 text-right font-normal">
                  Leads
                </th>
                <th scope="col" className="pr-4 text-right font-normal">
                  700+ doors
                </th>
                <th scope="col" className="text-right font-normal">
                  Cost
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={r.active ? 'text-fg' : 'text-fg-46'}>
                  <th scope="row" className="pr-4 text-[14px] font-medium">
                    {/^https?:\/\//i.test(r.linkedin_url ?? '') ? (
                      <a href={r.linkedin_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline">
                        {r.name} <ExternalLink className="size-3 opacity-60" strokeWidth={2} aria-hidden />
                      </a>
                    ) : (
                      r.name
                    )}
                    {!r.active && <span className="ml-2 text-[12px] font-normal">paused</span>}
                  </th>
                  <td className="pr-4 text-fg-70">{r.last_ran_at ? shortDate(ownerDate(r.last_ran_at)) : 'never'}</td>
                  <td className="pr-4 text-right font-mono tabular-nums">{num(r.last_posts)}</td>
                  <td className="pr-4 text-right font-mono tabular-nums">{num(r.last_reactors)}</td>
                  <td className="pr-4 text-right font-mono tabular-nums">{num(r.last_leads)}</td>
                  <td className="pr-4 text-right font-mono tabular-nums">{num(r.last_leads_700)}</td>
                  <td className="text-right font-mono text-fg-70 tabular-nums">{usd(r.last_cost_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Surface>
  )
}
