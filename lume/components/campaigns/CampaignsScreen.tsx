'use client'

import { useCallback, useState } from 'react'
import { Copy, Pause, Play } from 'lucide-react'
import { GlassCard } from '@/components/ui/glass-card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ActionNotice, noticeFrom, type NoticeState } from '@/components/campaigns/ActionNotice'
import { AnalyticsChart } from '@/components/campaigns/AnalyticsChart'
import { CampaignTable } from '@/components/campaigns/CampaignTable'
import { useReplyModes } from '@/components/campaigns/ReplyModeSelect'
import { FlowView } from '@/components/campaigns/FlowView'
import { InboxPane } from '@/components/campaigns/InboxPane'
import { SequenceEditor } from '@/components/campaigns/SequenceEditor'
import { CrmWorkspace } from '@/components/crm/CrmWorkspace'
import {
  requestCampaignAction,
  useCampaignAnalytics,
  useCampaignFlow,
  useCampaignInbox,
  useCampaignTable,
} from '@/hooks/useCampaignsScreen'
import type { CampaignActionKind } from '@/lib/actions/payloads'
import type { CampaignTableRow } from '@/lib/campaigns/types'

type Tab = 'analytics' | 'flow' | 'sequence' | 'inbox' | 'crm'

export function CampaignsScreen({ canChangeReplyMode = false }: { canChangeReplyMode?: boolean } = {}) {
  const table = useCampaignTable()
  const replyModes = useReplyModes()
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const rows = table.data?.campaigns
  const selected = rows?.find((r) => r.key === selectedKey) ?? null

  return (
    <div className="space-y-6">
      {table.error && !table.data ? (
        <GlassCard className="px-[18px] text-[13px] text-fg-46" role="alert">
          <div className="flex items-center justify-between">
            <span>Couldn&apos;t load campaigns.</span>
            <button type="button" onClick={() => void table.mutate()} className="text-[12px] text-violet-soft hover:text-fg">
              Retry
            </button>
          </div>
        </GlassCard>
      ) : (
        <CampaignTable
          rows={rows}
          instantly={table.data?.instantly}
          selectedKey={selectedKey}
          onSelect={(r) => setSelectedKey(r.key)}
          replyMode={{ modeOf: replyModes.modeOf, canChange: canChangeReplyMode, onChange: replyModes.setMode }}
        />
      )}
      {replyModes.error && (
        <p role="alert" className="text-[13px] text-red">
          {replyModes.error}
        </p>
      )}
      {selected && <CampaignDetail key={selected.key} row={selected} />}
    </div>
  )
}

function CampaignDetail({ row }: { row: CampaignTableRow }) {
  const id = row.instantly_id
  const [tab, setTab] = useState<Tab>('analytics')
  const [days, setDays] = useState<7 | 30>(7)
  const [notice, setNotice] = useState<NoticeState | null>(null)
  const [busy, setBusy] = useState(false)
  const [dupName, setDupName] = useState<string | null>(null)

  const analytics = useCampaignAnalytics(id && tab === 'analytics' ? id : null, days)
  const flow = useCampaignFlow(id && tab === 'flow' ? id : null)
  const inbox = useCampaignInbox(id && tab === 'inbox' ? id : null)
  const openInbox = useCallback(() => setTab('inbox'), [])

  const request = async (kind: CampaignActionKind, payload: Record<string, unknown>) => {
    setBusy(true)
    const r = await requestCampaignAction(kind, payload)
    setBusy(false)
    setNotice(noticeFrom(r))
    return r.ok
  }

  return (
    <GlassCard className="gap-4 px-[18px]" aria-label={`Campaign ${row.name}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-[17px] font-semibold text-fg">{row.name}</h2>
          <p className="text-[12px] text-fg-46 capitalize">
            {row.family} · {row.sender_type} · {row.status.replace(/_/g, ' ')}
          </p>
        </div>
        {id && (
          <div className="flex flex-wrap items-center gap-2">
            {row.status === 'active' && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => request('pause_campaign', { campaign_id: id, campaign_name: row.name })}>
                <Pause /> Pause
              </Button>
            )}
            {row.status === 'paused' && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => request('resume_campaign', { campaign_id: id, campaign_name: row.name })}>
                <Play /> Resume
              </Button>
            )}
            {dupName === null ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setDupName(`${row.name} (copy)`)}>
                <Copy /> Duplicate
              </Button>
            ) : (
              <form
                className="flex items-center gap-2"
                onSubmit={async (e) => {
                  e.preventDefault()
                  if (!dupName.trim()) return
                  if (await request('create_campaign', { source_campaign_id: id, name: dupName.trim(), campaign_name: row.name })) setDupName(null)
                }}
              >
                <Input value={dupName} onChange={(e) => setDupName(e.target.value)} maxLength={200} aria-label="New campaign name" className="h-7 w-56 text-[12px]" autoFocus />
                <Button size="sm" type="submit" disabled={busy || !dupName.trim()}>
                  Request
                </Button>
                <Button size="sm" variant="ghost" type="button" onClick={() => setDupName(null)}>
                  Cancel
                </Button>
              </form>
            )}
          </div>
        )}
      </div>
      {notice && <ActionNotice state={notice} onDismiss={() => setNotice(null)} />}

      {!id ? (
        <p className="py-4 text-[13px] text-fg-46">
          {row.sender_type === 'gmail' ? 'Gmail' : 'Muse'} campaigns are not wired to Lume yet — analytics, flow and inbox cover Instantly campaigns.
        </p>
      ) : (
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          <TabsList className="max-w-full overflow-x-auto [scrollbar-width:none]">
            <TabsTrigger value="analytics">Analytics</TabsTrigger>
            <TabsTrigger value="flow">Flow</TabsTrigger>
            <TabsTrigger value="sequence">Sequence</TabsTrigger>
            <TabsTrigger value="inbox">Inbox</TabsTrigger>
            <TabsTrigger value="crm">CRM</TabsTrigger>
          </TabsList>
          <TabsContent value="analytics" className="pt-3">
            <AnalyticsChart data={analytics.data} failed={!!analytics.error} days={days} onDays={setDays} />
          </TabsContent>
          <TabsContent value="flow" className="pt-3">
            <FlowView data={flow.data} failed={!!flow.error} campaignName={row.name} onOpenInbox={openInbox} />
          </TabsContent>
          <TabsContent value="sequence" className="pt-3">
            {tab === 'sequence' && <SequenceEditor campaignId={id} />}
          </TabsContent>
          <TabsContent value="inbox" className="pt-3">
            <InboxPane data={inbox.data} failed={!!inbox.error} campaignId={id} campaignName={row.name} />
          </TabsContent>
          <TabsContent value="crm" className="pt-3">
            {tab === 'crm' && (
              <CrmWorkspace
                campaignId={id}
                campaignLabel={row.name}
                crumbs={[{ label: 'Campaigns', href: '/campaigns' }, { label: row.name, href: `/crm?campaign=${encodeURIComponent(id)}` }, { label: 'CRM' }]}
              />
            )}
          </TabsContent>
        </Tabs>
      )}
    </GlassCard>
  )
}
