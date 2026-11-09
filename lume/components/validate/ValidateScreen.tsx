'use client'

import { useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { TagFilter } from '@/components/tags/TagChip'
import { matchesTag, tagFilterOptions } from '@/lib/tags/model'
import { useValidationQueue } from '@/hooks/useValidationQueue'
import { useProgress } from '@/hooks/useProgress'
import { RunningNow } from '@/components/progress/RunningNow'
import { ValidationHistory } from '@/components/validate/ValidationHistory'
import { ValidateView } from '@/components/validate/ValidateView'

/**
 * `/progress` (was /validate): "Running now" — one queue of every live
 * process (validation jobs, Apify runs, influencer runs and lookups,
 * Leadsfriday orders, job-search batches) and the last 24 h's finished ones —
 * then the validation history and "Waiting on you", the gate queue (SWR +
 * Realtime) with the `?gate=` deep link.
 */
export function ValidateScreen() {
  const q = useValidationQueue()
  const progress = useProgress()
  const params = useSearchParams()
  // Tag filter: "All · Kaspen · Job search …" over both lists (shown once more than one tag is present).
  const [tag, setTag] = useState('all')
  const options = useMemo(
    () => tagFilterOptions([...(progress.data?.running ?? []), ...(progress.data?.recent ?? []), ...(q.data ?? [])]),
    [progress.data, q.data]
  )
  const active = tag === 'all' || options.some((o) => (o.id ?? 'untagged') === tag) ? tag : 'all'
  const data = useMemo(
    () => (progress.data && active !== 'all' ? { ...progress.data, running: progress.data.running.filter((i) => matchesTag(i, active)), recent: progress.data.recent.filter((i) => matchesTag(i, active)) } : progress.data),
    [progress.data, active]
  )
  const gates = useMemo(() => (q.data && active !== 'all' ? q.data.filter((g) => matchesTag(g, active)) : q.data), [q.data, active])
  const idle = data ? data.running.length === 0 : false
  return (
    <div className="flex flex-col gap-5">
      <TagFilter options={options} value={active} onChange={setTag} />
      <RunningNow data={data} />
      <ValidationHistory />
      <section aria-label="Waiting on you" className="flex flex-col gap-3">
        <h2 className="text-[13px] font-semibold text-fg">Waiting on you</h2>
        <ValidateView
          gates={gates}
          error={q.error}
          onRefresh={() => void q.mutate()}
          deepLink={params.get('gate')}
          emptyText={active !== 'all' ? 'Nothing waiting on you with this tag.' : idle ? 'Nothing running, nothing waiting on you.' : 'Nothing waiting on you'}
        />
      </section>
    </div>
  )
}
