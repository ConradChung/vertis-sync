'use client'

import useSWR from 'swr'
import { ExternalLink, Phone } from 'lucide-react'
import { Surface } from '@/components/shell/Surface'
import { Scoreboard } from '@/components/today/Scoreboard'
import { fetchJson } from '@/hooks/fetcher'
import { shortDate } from '@/lib/crm/pilot'
import type { PortalSignalsResponse } from '@/lib/portal/signals'
import { SOURCE_LABEL } from '@/lib/signals/merge'
import { ownerDate } from '@/lib/time/owner'
import { displayPhone, phoneHref } from './format'
import { withAs } from './query'

/**
 * The top of the client portal: this week's scoreboard and today's signal
 * accounts to call, above the campaign lead lists. Read only. It renders
 * nothing for a client without signal lanes, while loading, or on an error,
 * so the lead lists below are never held up by it.
 */
export function SignalsSection({ as }: { as?: string | null }) {
  const { data } = useSWR<PortalSignalsResponse>(withAs('/api/portal/signals', as), fetchJson, { revalidateOnFocus: false, shouldRetryOnError: false })
  if (!data?.enabled) return null
  return (
    <Surface data-testid="portal-signals" className="gap-10">
      {data.scoreboard && <Scoreboard board={data.scoreboard} />}
      <section aria-label="Signal accounts to call today" className="flex flex-col gap-6">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="text-[15px] font-medium text-fg">Signal accounts to call today</h2>
          <span className="font-mono text-[12px] text-fg-46">{data.accounts.length + data.more}</span>
        </div>
        {data.accounts.length === 0 ? (
          <p className="text-[13px] text-fg-46">No signal accounts waiting for a call.</p>
        ) : (
          <ul className="flex flex-col gap-6">
            {data.accounts.map((a) => {
              const tel = phoneHref(a.phone)
              return (
                <li key={a.key} className="flex flex-wrap items-center gap-x-6 gap-y-2">
                  <div className="min-w-0 flex-1 basis-64">
                    <p className="flex flex-wrap items-baseline gap-x-3">
                      <span className="text-[15px] font-medium text-fg">{a.company}</span>
                      {a.website && (
                        <a href={'https://' + a.website} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[13px] text-fg-46 hover:text-fg">
                          {a.website} <ExternalLink className="size-3" strokeWidth={1.75} aria-hidden />
                        </a>
                      )}
                    </p>
                    <p className="mt-1 line-clamp-2 text-[13px] text-fg-70">{a.untrusted_signal}</p>
                    <p className="mt-1 flex flex-wrap gap-x-3 text-[12px] text-fg-46">
                      <span>{a.sources.map((s) => SOURCE_LABEL[s]).join(' · ')}</span>
                      {a.signal_at && <time dateTime={a.signal_at}>{shortDate(ownerDate(a.signal_at))}</time>}
                      {a.contact && <span>{[a.contact.name, a.contact.title].filter(Boolean).join(', ')}</span>}
                    </p>
                  </div>
                  {tel && a.phone ? (
                    <a
                      href={tel}
                      className="inline-flex h-11 shrink-0 items-center gap-2 rounded-lg bg-secondary px-4 font-mono text-[14px] font-medium text-fg outline-none hover:bg-foreground/12 focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Phone className="size-4" strokeWidth={2} aria-hidden />
                      {displayPhone(a.phone)}
                    </a>
                  ) : (
                    <span className="shrink-0 text-[13px] text-fg-46">No phone yet</span>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        {data.more > 0 && <p className="text-[12px] text-fg-46">And {data.more} more.</p>}
      </section>
    </Surface>
  )
}
