import type { ReactNode } from 'react'
import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { PageHead } from '@/components/shell/PageHead'
import { RunSurface } from '@/components/runs/parts'
import { InfluencerRunDetail } from '@/components/runs/InfluencerRunDetail'
import { CompanyCheckDetail } from '@/components/runs/CompanyCheckDetail'
import { ApifyDetailView, JobBatchDetailView, LookupDetailView, OrderDetailView } from '@/components/runs/SimpleDetails'
import { requireOwner } from '@/lib/auth/guards'
import { isRunKind, KIND_LABEL, parseRunId } from '@/lib/runs/model'
import { loadApify, loadCompanyCheck, loadInfluencerRun, loadJobBatch, loadLookup, loadOrder } from '@/lib/runs/load'

export const metadata: Metadata = { title: 'Run' }
export const dynamic = 'force-dynamic'

/**
 * `/runs/<kind>/<id>`: one run, whatever made it. The target of every
 * activity card's "Open" (lib/progress/model.ts). Read-only: nothing here
 * spends or decides; approvals stay on `/actions/<id>`.
 */
export default async function RunPage({ params }: { params: Promise<{ kind: string; id: string }> }) {
  const auth = await requireOwner()
  if (!auth.ok) notFound()
  const p = await params
  if (!isRunKind(p.kind)) notFound()
  const kind = p.kind
  const id = parseRunId(kind, p.id)
  if (!id) notFound()

  // Validation jobs already have a run-specific view.
  if (kind === 'validation') redirect(`/progress?run=${id}`)

  let title: string
  let status: string | null
  let body: ReactNode
  switch (kind) {
    case 'influencer_run': {
      const d = await loadInfluencerRun(id)
      if (!d) notFound()
      const n = d.run.influencer_ids.length
      title = d.influencers.length && d.influencers.length <= 3 ? d.influencers.map((i) => i.name).join(', ') : `${n} influencer${n === 1 ? '' : 's'}`
      status = d.run.status
      body = <InfluencerRunDetail d={d} />
      break
    }
    case 'company_check': {
      const d = await loadCompanyCheck(id)
      if (!d) notFound()
      title = d.job?.display_name?.trim() || d.job?.filename || d.run.job_id
      status = d.run.status
      body = <CompanyCheckDetail d={d} />
      break
    }
    case 'influencer_lookup': {
      const d = await loadLookup(id)
      if (!d) notFound()
      title = d.batch.name
      status = d.batch.status
      body = <LookupDetailView d={d} />
      break
    }
    case 'leadsfriday_order': {
      const d = await loadOrder(id)
      if (!d) notFound()
      title = d.contact_count ? `${d.contact_count.toLocaleString('en-US')} contacts` : 'Apollo order'
      status = d.status
      body = <OrderDetailView d={d} />
      break
    }
    case 'job_batch': {
      const d = await loadJobBatch(id)
      if (!d) notFound()
      title = d.batch_date ? `Jobs · ${d.batch_date}` : 'Jobs batch'
      status = d.status
      body = <JobBatchDetailView d={d} />
      break
    }
    case 'apify': {
      const d = await loadApify(id)
      title = (d.configured && d.run?.actorId) || id
      status = d.configured && d.run ? d.run.status : null
      body = <ApifyDetailView d={d} />
      break
    }
    default:
      notFound()
  }

  return (
    <>
      <PageHead eyebrow="Run" title={KIND_LABEL[kind]} sub="Everything this one run did: status, counts, cost and what it produced." />
      <RunSurface kind={KIND_LABEL[kind]} title={title} status={status}>
        {body}
      </RunSurface>
    </>
  )
}
