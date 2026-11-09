'use client'

import { useEffect, useRef, useState } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { SimpleSelect } from '@/components/ui/simple-select'
import { GlassCard } from '@/components/ui/glass-card'
import { NotConnected, SectionTitle, ShimmerBar } from '@/components/overview/parts'
import { Switch } from '@/components/validate/Switch'
import { jobKey, previewKey, useInstantlyCampaigns, useJobProgress } from '@/hooks/useJob'
import type { GateRow } from '@/lib/db/types'
import { sendJson } from '@/lib/validate/client'
import { fetchJson } from '@/hooks/fetcher'
import { NewCampaignSheet } from '@/components/campaigns/NewCampaignSheet'

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
    <>
      <Barriers jobId={gate.target_id} />
      <NoLocation jobId={gate.target_id} />
    </>
  )
}

function CampaignPick({ gate, focusTick }: { gate: GateRow; focusTick: number }) {
  const { mutate } = useSWRConfig()
  const { data, error, mutate: reload } = useInstantlyCampaigns(true)
  const [selected, setSelected] = useState('')
  const [saving, setSaving] = useState(false)
  const [creating, setCreating] = useState(false)
  const selectRef = useRef<HTMLButtonElement>(null)
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
            <SimpleSelect
              id={`camp-${gate.target_id}`}
              triggerRef={selectRef}
              value={selected}
              disabled={!configured || saving}
              onValueChange={setSelected}
              className="h-9 text-[12px]"
              options={[
                { value: '', label: configured ? `Select a campaign… (${campaigns.length})` : 'Instantly not connected' },
                ...campaigns.map((c) => ({ value: c.id, label: `${c.name} (${c.statusLabel})` })),
              ]}
            />
            <div className="flex items-center gap-2">
              <Button size="sm" disabled={!configured || !selected || saving} onClick={() => void save()}>
                {saving ? 'Saving…' : 'Use this campaign'}
              </Button>
              <span className="text-[11px] text-fg-46">Nothing is pushed yet — barriers and names come next.</span>
            </div>
            <button
              type="button"
              className="self-start text-[12px] text-violet-soft hover:text-fg disabled:opacity-50"
              disabled={!configured}
              onClick={() => setCreating(true)}
            >
              Or create a campaign for this list →
            </button>
            <NewCampaignSheet
              open={creating}
              onOpenChange={(o) => {
                setCreating(o)
                if (!o) {
                  void mutate('/api/gates')
                  void mutate(jobKey(gate.target_id))
                }
              }}
              jobId={gate.target_id}
            />
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

type NoLocationInfo = {
  locationless: number
  main: { id: string; name: string | null } | null
  sibling: { id: string; name: string | null } | null
  suggested_name: string | null
  strip: { ok: boolean; removed?: number; kept?: number; reason?: string; step?: number } | null
  templates: { id: string; name: string }[]
}

const noLocationKey = (jobId: string) => `/api/gates/campaign/${jobId}/nolocation`

/**
 * Valid leads with no resolved city would send with a blank where {{location}}
 * goes, and Instantly picks variants itself. Recommend a sibling campaign with
 * location-free copy (or an existing one); instantly-push routes them there.
 */
function NoLocation({ jobId }: { jobId: string }) {
  const { mutate } = useSWRConfig()
  const { data, mutate: reload } = useSWR<NoLocationInfo>(noLocationKey(jobId), fetchJson)
  const { data: campaigns } = useInstantlyCampaigns(true)
  const { data: job } = useJobProgress(jobId)
  const [source, setSource] = useState('')
  const [existing, setExisting] = useState('')
  const [saving, setSaving] = useState(false)

  if (!data || (!data.locationless && !data.sibling)) return null
  const n = data.locationless.toLocaleString()

  if (data.sibling) {
    return (
      <GlassCard className="gap-1 px-[18px] py-4" aria-label="No-location campaign">
        <p className="text-[13px] font-medium text-fg">No-location campaign: {data.sibling.name}</p>
        <p className="text-[12px] text-fg-46">
          {job?.location_barrier
            ? `Location barrier is on, so the ${n} lead${data.locationless === 1 ? '' : 's'} without a city are dropped — turn it off to send them here.`
            : `${n} valid lead${data.locationless === 1 ? '' : 's'} without a city go there on push.`}{' '}
          It&apos;s a draft until you launch it in Instantly.
        </p>
      </GlassCard>
    )
  }

  const options = [
    ...(data.strip?.ok ? [{ value: '', label: `Copy of ${data.main?.name ?? 'the main campaign'} without its {{location}} variants (${data.strip.removed} removed)` }] : []),
    ...data.templates.map((t) => ({ value: `tpl:${t.id}`, label: `Template: ${t.name}` })),
    { value: 'existing', label: 'Use a campaign I already have…' },
  ]
  const pick = source || options[0]?.value || ''
  const others = campaigns && campaigns.configured ? campaigns.campaigns.filter((c) => c.id !== data.main?.id) : []

  async function go() {
    setSaving(true)
    const body =
      pick === 'existing' ? { mode: 'existing', campaign_id: existing } : pick.startsWith('tpl:') ? { mode: 'create', template_id: pick.slice(4) } : { mode: 'create' }
    const r = await sendJson(noLocationKey(jobId), body)
    setSaving(false)
    const err = (r.body as { error?: string } | null)?.error
    if (r.status === 200) toast.success(pick === 'existing' ? 'No-location campaign set' : `Created “${data?.suggested_name}” (draft)`, { description: `${n} city-less leads will go there on push.` })
    else if (err === 'needs_template') toast.error('Every variant of a step uses {{location}} — pick a template instead')
    else if (err === 'push_awaiting_confirmation') toast.info('A push confirmation is waiting — settings are locked')
    else toast.error("Couldn't set up the no-location campaign", { description: err ?? undefined })
    void reload()
    void mutate(previewKey(jobId))
    void mutate(jobKey(jobId))
  }

  return (
    <GlassCard className="gap-3 px-[18px] py-4" aria-label="No-location campaign">
      <div>
        <p className="text-[13px] font-medium text-fg">Recommended: a no-location campaign</p>
        <p className="mt-1 text-[12px] leading-5 text-fg-46">
          {n} valid lead{data.locationless === 1 ? ' has' : 's have'} no resolved city. Instantly chooses variants itself, so they could get copy with a blank
          where {'{{location}}'} goes. Send them to a sibling campaign that never mentions a city — same inboxes, schedule and limits.
          {job?.location_barrier && ' (The Location barrier is on and drops them today; turn it off once this is set.)'}
        </p>
      </div>
      <SimpleSelect aria-label="No-location copy" value={pick} onValueChange={setSource} className="h-9 text-[12px]" options={options} />
      {pick === 'existing' && (
        <SimpleSelect
          aria-label="Existing campaign"
          value={existing}
          onValueChange={setExisting}
          className="h-9 text-[12px]"
          options={[{ value: '', label: `Select a campaign… (${others.length})` }, ...others.map((c) => ({ value: c.id, label: c.name }))]}
        />
      )}
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={saving || (pick === 'existing' && !existing)} onClick={() => void go()}>
          {saving ? 'Working…' : pick === 'existing' ? 'Use this campaign' : `Create “${data.suggested_name ?? 'No Location'}”`}
        </Button>
        <span className="text-[11px] text-fg-46">Created as a draft — nothing sends until you launch it.</span>
      </div>
    </GlassCard>
  )
}
