'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTheme } from 'next-themes'
import { ReactFlow, type Edge } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { GlassNode, type GlassFlowNode } from '@/components/campaigns/GlassNode'
import { FeederNode, type FeederFlowNode } from '@/components/campaigns/FeederNode'
import { ActionNotice, noticeFrom, type NoticeState } from '@/components/campaigns/ActionNotice'
import { NotConnected, ShimmerBar } from '@/components/overview/parts'
import { requestCampaignAction } from '@/hooks/useCampaignsScreen'
import type { CampaignFlowResponse, FlowStage } from '@/lib/campaigns/types'

const nodeTypes = { glass: GlassNode, feeder: FeederNode }

const COL = 196
const BRANCH_Y = 200
const FEEDER_GAP = 138
const fmt = new Intl.NumberFormat('en-US')
// Non-draggable, non-selectable nodes get pointer-events: none from React Flow,
// which made the Run buttons, links and tooltips inside them unclickable.
const INTERACTIVE = { pointerEvents: 'all' as const }
const LIT = new Set<FlowStage['status']>(['done', 'active', 'waiting'])

function edgeStyle(from: FlowStage['status'], to: FlowStage['status']) {
  if (LIT.has(from) && LIT.has(to)) return { stroke: 'var(--chart-line)', strokeWidth: 2 }
  if (from === 'unused' || to === 'unused') return { stroke: 'var(--fg-24)', strokeDasharray: '4 4' }
  return { stroke: 'var(--fg-24)' }
}

/**
 * Main path Import → Validate → Enrich → Push → Emails sent → Replies, and
 * the forked branch below it: Lead bank → scheduled feeders (rotation rules,
 * the instantly-rotate cron) joining at Emails sent. Completed stages are
 * lit lime, the current one pulses, unused paths are dashed. "Run" on a
 * stage opens its gate, creates a pause/resume pending action, or is
 * disabled with the reason; nothing here calls Instantly.
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

  const hasBranch = !!data && (data.counts.bank_total > 0 || data.feeders.length > 0)

  const nodes = useMemo<(GlassFlowNode | FeederFlowNode)[]>(() => {
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
    const main: (GlassFlowNode | FeederFlowNode)[] = data.stages.map((stage, i) => ({
      id: stage.id,
      type: 'glass',
      position: { x: i * COL, y: 0 },
      data: { stage, busy, onRun },
      draggable: false,
      style: INTERACTIVE,
    }))
    if (!hasBranch) return main
    const branch: (GlassFlowNode | FeederFlowNode)[] = [
      { id: 'bank', type: 'glass', position: { x: COL * 0.5, y: BRANCH_Y }, data: { stage: data.bank, busy, onRun }, draggable: false, style: INTERACTIVE },
      ...data.feeders.map(
        (feeder, k): FeederFlowNode => ({
          id: feeder.id,
          type: 'feeder',
          position: { x: COL * 1.75, y: BRANCH_Y + k * FEEDER_GAP },
          data: { feeder },
          draggable: false,
          style: INTERACTIVE,
        })
      ),
    ]
    return [...main, ...branch]
  }, [data, busy, router, onOpenInbox, campaignName, hasBranch])

  const edges = useMemo<Edge[]>(() => {
    if (!data) return []
    const st = data.stages
    const out: Edge[] = st.slice(1).map((s, i) => ({
      id: `${st[i].id}-${s.id}`,
      source: st[i].id,
      target: s.id,
      animated: s.status === 'active' || s.status === 'waiting',
      style: edgeStyle(st[i].status, s.status),
    }))
    if (hasBranch) {
      const send = st.find((s) => s.id === 'send')
      for (const f of data.feeders) {
        const fStatus: FlowStage['status'] = f.active ? (f.last_run ? 'done' : 'idle') : 'unused'
        out.push({ id: `bank-${f.id}`, source: 'bank', target: f.id, style: edgeStyle(data.bank.status, fStatus) })
        out.push({
          id: `${f.id}-send`,
          source: f.id,
          target: 'send',
          targetHandle: 'bottom',
          type: 'smoothstep',
          animated: f.active && send?.status === 'active',
          style: edgeStyle(fStatus, send?.status ?? 'idle'),
        })
      }
    }
    return out
  }, [data, hasBranch])

  if (failed && !data) return <p className="py-6 text-[13px] text-fg-46" role="alert">Couldn&apos;t load the flow.</p>
  if (!data) return <ShimmerBar className="h-[200px] w-full" />

  return (
    <div className="space-y-3">
      {data.instantly === 'not_configured' && <NotConnected>Instantly not connected — send/reply counts unavailable</NotConnected>}
      {data.instantly === 'error' && <p className="text-[11px] text-amber">Instantly unreachable — send/reply counts unavailable</p>}
      <div
        className="w-full overflow-hidden rounded-xl border border-border bg-(--glass-fill)"
        style={{ height: hasBranch ? Math.min(540, 270 + Math.max(1, data.feeders.length) * 120) : 220 }}
        aria-label="Campaign flow"
      >
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
      <p className="text-[12px] text-fg-46">{sourcesLine(data)}</p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-fg-46" aria-label="Legend">
        <li className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-lime" /> done</li>
        <li className="flex items-center gap-1.5"><span className="size-2.5 animate-pulse rounded-full bg-lime ring-2 ring-lime/40" /> current</li>
        <li className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-fg-24" /> not reached</li>
        <li className="flex items-center gap-1.5"><span className="size-2.5 rounded-full border border-dashed border-fg-46" /> path not used</li>
      </ul>
      {notice && <ActionNotice state={notice} onDismiss={() => setNotice(null)} />}
    </div>
  )
}

/** One sentence on where this campaign's leads come from, with the numbers. */
function sourcesLine(d: CampaignFlowResponse): string {
  const c = d.counts
  const parts: string[] = []
  if (d.jobs.length) parts.push(`${d.jobs.length} validation job${d.jobs.length === 1 ? '' : 's'} (${fmt.format(c.pushed)} pushed)`)
  if (c.bank_total) {
    const rot = d.feeders.find((f) => f.kind === 'system')
    parts.push(
      `the lead bank (${fmt.format(c.bank_total)} leads${rot && c.rotated ? `; auto-rotation added ${fmt.format(c.rotated)} into Instantly` : ''})`
    )
  }
  if (!parts.length) return 'No leads have reached this campaign through Lume yet.'
  return `Leads reach this campaign from ${parts.join(' and ')}. Emails sent counts every email, follow-ups included.`
}
