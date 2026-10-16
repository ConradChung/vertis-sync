'use client'

import { useEffect, useRef, useState } from 'react'
import { useSWRConfig } from 'swr'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { GlassCard } from '@/components/ui/glass-card'
import { NotConnected, SectionTitle, ShimmerBar } from '@/components/overview/parts'
import { Switch } from '@/components/validate/Switch'
import { jobKey, previewKey, useInstantlyCampaigns, useJobProgress } from '@/hooks/useJob'
import type { GateRow } from '@/lib/db/types'
import { sendJson } from '@/lib/validate/client'

/**
 * Lume-local push settings (plain PATCHes, not entrypoint claims):
 *  - campaign_choice: pick an Instantly campaign → POST /api/gates/campaign/<job>
 *    (conditional on the job still waiting; moves it to the barrier step).
 *  - push_review: location / company barriers → PATCH, then the preview
 *    re-reads (the names shown come from instantly-push itself).
 */
export function BarrierPanel({ gate, pickerFocusTick = 0 }: { gate: GateRow; pickerFocusTick?: number }) {
  return gate.kind === 'campaign_choice' ? (
    <CampaignPick gate={gate} focusTick={pickerFocusTick} />
  ) : (
    <Barriers jobId={gate.target_id} />
  )
}

function CampaignPick({ gate, focusTick }: { gate: GateRow; focusTick: number }) {
  const { mutate } = useSWRConfig()
  const { data, error, mutate: reload } = useInstantlyCampaigns(true)
  const [selected, setSelected] = useState('')
  const [saving, setSaving] = useState(false)
  const selectRef = useRef<HTMLSelectElement>(null)
  const configured = data?.configured === true
  const campaigns = data && data.configured ? data.campaigns : []

  useEffect(() => {
    if (focusTick > 0) selectRef.current?.focus()
  }, [focusTick])

  async function save() {
    const c = campaigns.find((x) => x.id === selected)
    if (!c) return
    setSaving(true)
    const r = await sendJson(`/api/gates/campaign/${gate.target_id}`, { campaign_id: c.id, campaign_name: c.name })
    setSaving(false)
    if (r.status === 200) toast.success(`Campaign set: ${c.name}`, { description: 'Next: barriers and the name preview.' })
    else if (r.status === 409) toast.info('Already handled — refreshed')
    else toast.error("Couldn't save the campaign", { description: 'Nothing changed. The Telegram prompt still works.' })
    void mutate('/api/gates')
    void mutate(jobKey(gate.target_id))
  }

  return (
    <GlassCard className="gap-0 py-0" aria-label="Pick a campaign">
      <SectionTitle title="Instantly campaign" />
      <div className="flex flex-col gap-3 px-[18px] pb-[18px]">
        {!data && !error && <ShimmerBar className="h-8 w-full" />}
        {error && (
          <p className="flex items-center gap-3 text-[12px] text-fg-70" role="alert">
            Couldn&apos;t load campaigns.
            <button type="button" className="text-violet-soft hover:text-fg" onClick={() => void reload()}>
              Retry
            </button>
          </p>
        )}
        {data && !configured && <NotConnected />}
        {data && (
          <>
            <label htmlFor={`camp-${gate.target_id}`} className="sr-only">
              Campaign
            </label>
            <select
              id={`camp-${gate.target_id}`}
              ref={selectRef}
              value={selected}
              disabled={!configured || saving}
              onChange={(e) => setSelected(e.target.value)}
              className="h-9 w-full rounded-[9px] border border-line bg-black/20 px-2.5 text-[12px] text-fg outline-none focus-visible:border-violet disabled:opacity-50"
            >
              <option value="">{configured ? `Select a campaign… (${campaigns.length})` : 'Instantly not connected'}</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.statusLabel})
                </option>
              ))}
            </select>
            <div className="flex items-center gap-2">
              <Button size="sm" disabled={!configured || !selected || saving} onClick={() => void save()}>
                {saving ? 'Saving…' : 'Use this campaign'}
              </Button>
              <span className="text-[11px] text-fg-46">Nothing is pushed yet — barriers and names come next.</span>
            </div>
          </>
        )}
      </div>
    </GlassCard>
  )
}

function Barriers({ jobId }: { jobId: string }) {
  const { mutate } = useSWRConfig()
  const { data: job } = useJobProgress(jobId)
  const [saving, setSaving] = useState(false)

  async function patch(p: Record<string, boolean>) {
    setSaving(true)
    // Optimistic: the switch moves now, the server row decides.
    void mutate(jobKey(jobId), (cur: unknown) => (cur ? { ...(cur as object), ...p } : cur), { revalidate: false })
    const r = await sendJson(`/api/gates/campaign/${jobId}`, p, { method: 'PATCH' })
    setSaving(false)
    if (r.status === 409 && (r.body as { error?: string } | null)?.error === 'push_awaiting_confirmation')
      toast.info('A push confirmation is waiting — settings are locked')
    else if (r.status === 409) toast.info('Already handled — refreshed')
    else if (r.status !== 200) toast.error("Couldn't save that setting")
    void mutate(jobKey(jobId))
    void mutate(previewKey(jobId))
    void mutate('/api/gates')
  }

  return (
    <GlassCard className="gap-0 py-0" aria-label="Barriers">
      <SectionTitle title="Barriers">{job?.instantly_campaign_name && <span>→ {job.instantly_campaign_name}</span>}</SectionTitle>
      <div className="flex flex-col gap-1 px-[10px] pb-[14px]">
        {!job ? (
          <div className="px-2">
            <ShimmerBar className="h-8 w-full" />
          </div>
        ) : (
          <>
            <Switch
              label="Location barrier"
              hint={job.location_barrier ? 'Resolved city + high confidence only' : 'Keep every row, blank unknown cities'}
              checked={job.location_barrier}
              disabled={saving}
              onChange={(v) => void patch({ location_barrier: v })}
            />
            <Switch
              label="Company barrier"
              hint={job.company_barrier ? 'Drop junk company names' : 'No filtering — names pushed as normalized'}
              checked={job.company_barrier}
              disabled={saving}
              onChange={(v) => void patch({ company_barrier: v })}
            />
          </>
        )}
      </div>
    </GlassCard>
  )
}
