'use client'

import { useCallback, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ProgressBoard } from '@/components/progress/ProgressBoard'
import { useInstantlyCampaigns, useJobProgress } from '@/hooks/useJob'
import { useProgress } from '@/hooks/useProgress'
import { useRuns } from '@/hooks/useRuns'
import { useValidationQueue } from '@/hooks/useValidationQueue'
import { defaultRunId, fromJobProgress, fromRunRow, ingestRuns, isIngestRun, mergeRuns, parseRunParam, resolveGateLink, selectRun } from '@/lib/progress/runs'

/**
 * `/progress`: one CSV run at a time. `?run=<job id>` (or the older
 * `?job=`) picks the run; `?gate=<kind>:<id>` (Telegram / alert deep links)
 * opens the gate's run at its step; otherwise the most recently active run
 * that is running or waiting on the owner. Data: /api/gates (SWR +
 * Realtime), /api/validation-jobs/runs, /api/jobs/<id>, /api/progress.
 */
export function ProgressScreen() {
  const q = useValidationQueue()
  const progress = useProgress()
  const runsQ = useRuns()
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  const runParam = parseRunParam(params.get('run') ?? params.get('job'))
  const gateParam = params.get('gate')
  const gates = q.data
  const gateLink = useMemo(() => (gates ? resolveGateLink(gateParam, gates) : null), [gates, gateParam])

  const [clicked, setClicked] = useState<string | null>(null)
  const baseRuns = useMemo(() => mergeRuns((runsQ.data?.runs ?? []).map(fromRunRow), ingestRuns(gates ?? [])), [runsQ.data, gates])
  const sel = selectRun({ clicked, runParam, gate: gateLink, runs: baseRuns, gates: gates ?? [] })
  // The default waits for both lists, so it doesn't flip once the gates arrive.
  let selectedId = sel.source === 'default' && (!runsQ.data || !gates) ? null : sel.runId
  // A CSV that was approved (or denied) since: its ingest run is gone — fall back to the default.
  if (selectedId && isIngestRun(selectedId) && gates && !baseRuns.some((r) => r.id === selectedId)) selectedId = runsQ.data ? defaultRunId(baseRuns, gates) : null

  const jobId = selectedId && !isIngestRun(selectedId) ? selectedId : null
  const jobQ = useJobProgress(jobId)
  const runs = useMemo(
    () => (jobQ.data && jobQ.data.id === jobId && !baseRuns.some((r) => r.id === jobId) ? [...baseRuns, fromJobProgress(jobQ.data)] : baseRuns),
    [baseRuns, jobQ.data, jobId]
  )

  const job = jobId ? (jobQ.data && jobQ.data.id === jobId ? jobQ.data : jobQ.error ? null : undefined) : null
  const wantsCampaign = Boolean(job && job.instantly_status === 'done' && job.instantly_campaign_id)
  const campaigns = useInstantlyCampaigns(wantsCampaign).data
  const campaignStatus = wantsCampaign && campaigns?.configured ? (campaigns.campaigns.find((c) => c.id === job?.instantly_campaign_id)?.statusLabel ?? null) : null

  const onSelectRun = useCallback(
    (id: string) => {
      setClicked(id)
      router.replace(`${pathname}?run=${encodeURIComponent(id)}`, { scroll: false })
    },
    [router, pathname]
  )
  const refresh = useCallback(() => {
    void q.mutate()
    void runsQ.mutate()
    void jobQ.mutate()
  }, [q, runsQ, jobQ])

  return (
    <ProgressBoard
      gates={gates}
      gatesError={q.error}
      onRefresh={refresh}
      runs={runs}
      runsLoaded={Boolean(runsQ.data) || Boolean(runsQ.error)}
      selectedId={selectedId}
      onSelectRun={onSelectRun}
      job={job}
      jobError={jobQ.error}
      progress={progress.data}
      gateLink={gateLink}
      campaignStatus={campaignStatus}
    />
  )
}
