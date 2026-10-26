'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTheme } from 'next-themes'
import { ReactFlow, type Edge } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { GlassNode, type GlassFlowNode } from '@/components/campaigns/GlassNode'
import { ActionNotice, noticeFrom, type NoticeState } from '@/components/campaigns/ActionNotice'
import { NotConnected, ShimmerBar } from '@/components/overview/parts'
import { requestCampaignAction } from '@/hooks/useCampaignsScreen'
import type { CampaignFlowResponse, FlowStage } from '@/lib/campaigns/types'

const nodeTypes = { glass: GlassNode }

/**
 * Import → Validate → Enrich → Push → Send → Reply. "Run" on a stage opens
 * its gate, creates a pause/resume pending action, or is disabled with the
 * reason; nothing here calls Instantly.
 */
export function FlowView({
  data,
  failed,
  campaignName,
  onOpenInbox,
}: {
  data: CampaignFlowResponse | undefined
  failed: boolean
  campaignName: string
  onOpenInbox: () => void
}) {
  const router = useRouter()
  const { resolvedTheme } = useTheme()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<NoticeState | null>(null)

  const nodes = useMemo<GlassFlowNode[]>(() => {
    if (!data) return []
    const onRun = async (stage: FlowStage) => {
      const a = stage.action
      if (a.type === 'link') return router.push(a.href)
      if (a.type === 'tab') return onOpenInbox()
      if (a.type !== 'pending') return
      setBusy(true)
      const r = await requestCampaignAction(a.kind, { campaign_id: data.campaign_id, campaign_name: campaignName })
      setBusy(false)
      setNotice(noticeFrom(r))
    }
    return data.stages.map((stage, i) => ({
      id: stage.id,
      type: 'glass',
      position: { x: i * 180, y: 0 },
      data: { stage, busy, onRun },
      draggable: false,
    }))
  }, [data, busy, router, onOpenInbox, campaignName])

  const edges = useMemo<Edge[]>(
    () =>
      (data?.stages ?? []).slice(1).map((s, i) => ({
        id: `${data!.stages[i].id}-${s.id}`,
        source: data!.stages[i].id,
        target: s.id,
        animated: s.status === 'active' || s.status === 'waiting',
        style: { stroke: 'var(--fg-24)' },
      })),
    [data]
  )

  if (failed && !data) return <p className="py-6 text-[13px] text-fg-46" role="alert">Couldn&apos;t load the flow.</p>
  if (!data) return <ShimmerBar className="h-[200px] w-full" />

  return (
    <div className="space-y-3">
      {data.instantly === 'not_configured' && <NotConnected>Instantly not connected — send/reply counts unavailable</NotConnected>}
      {data.instantly === 'error' && <p className="text-[11px] text-amber">Instantly unreachable — send/reply counts unavailable</p>}
      <div className="h-[200px] w-full overflow-hidden rounded-xl border border-border bg-(--glass-fill)" aria-label="Campaign flow">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          zoomOnScroll={false}
          panOnScroll={false}
          colorMode={resolvedTheme === 'light' ? 'light' : 'dark'}
          style={{ background: 'transparent' }}
        />
      </div>
      <ul className="grid gap-1 text-[11px] text-fg-46 sm:grid-cols-2">
        {data.stages
          .filter((s) => s.action.type === 'disabled')
          .map((s) => (
            <li key={s.id}>
              <span className="text-fg">{s.label}:</span> {s.action.type === 'disabled' ? s.action.reason : ''}
            </li>
          ))}
      </ul>
      <p className="text-[11px] text-fg-24">
        {data.jobs.length} validation job{data.jobs.length === 1 ? '' : 's'} feed this campaign.
      </p>
      {notice && <ActionNotice state={notice} onDismiss={() => setNotice(null)} />}
    </div>
  )
}
