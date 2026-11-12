'use client'

import { useEffect, useState } from 'react'
import useSWR from 'swr'
import { toast } from 'sonner'
import { ArrowRightLeft, Play, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SimpleSelect } from '@/components/ui/simple-select'
import { PreviewLeadsButton } from '@/components/validate/ValidatedPreview'
import { fetchJson } from '@/hooks/fetcher'
import { errorText, requestBankQueue, stopPushQueue } from '@/lib/rules/client'
import type { PushCampaign, PushGroup } from '@/lib/rotation/pushes'
import { cn } from '@/lib/utils'

const fmt = new Intl.NumberFormat('en-US')
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null)

interface PushesPayload {
  pushes: PushGroup[]
  campaigns: { id: string; name: string }[]
}

function confirmToast(text: string, actionId: string) {
  toast.success(text, {
    description: 'Waiting for your tap — here or in Telegram.',
    action: { label: 'Review', onClick: () => window.location.assign(`/actions/${actionId}`) },
  })
}

function Stat({ n, label, tone }: { n: number; label: string; tone?: string }) {
  return (
    <span className={cn('font-mono text-[12px] tabular-nums', n ? (tone ?? 'text-fg') : 'text-fg-24')}>
      {fmt.format(n)} <span className="text-fg-46">{label}</span>
    </span>
  )
}

/** One push x campaign: counts, then Stop (now, two clicks), Restart and Move (each files an approval). */
function CampaignRow({ group, c, campaigns, onDone }: { group: PushGroup; c: PushCampaign; campaigns: PushesPayload['campaigns']; onDone: () => void }) {
  const [armed, setArmed] = useState(false)
  const [moving, setMoving] = useState(false)
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(t)
  }, [armed])

  const stop = async () => {
    if (!armed) return setArmed(true)
    setArmed(false)
    setBusy(true)
    const a = await stopPushQueue(group.source_job_id, c.campaign_id)
    setBusy(false)
    if (a.status === 200 && a.body) toast.success(`Stopped ${fmt.format(a.body.stopped)} queued leads`, { description: `${group.name} → ${c.campaign_name}. Restart puts them back in line.` })
    else toast.error(errorText(a))
    onDone()
  }
  const file = async (op: 'restart' | 'move') => {
    setBusy(true)
    const a = await requestBankQueue({ op, source_job_id: group.source_job_id, campaign_id: c.campaign_id, ...(op === 'move' ? { to_campaign_id: to } : {}) })
    setBusy(false)
    if (a.status === 201 && a.body) {
      confirmToast(op === 'restart' ? 'Restart requested' : 'Move requested', a.body.action.id)
      setMoving(false)
      setTo('')
    } else toast.error(a.status === 409 ? 'A restart or move for this push is already waiting for your tap.' : errorText(a))
    onDone()
  }
  const targets = campaigns.filter((x) => x.id !== c.campaign_id).map((x) => ({ value: x.id, label: x.name }))

  return (
    <li className="flex flex-col gap-2 rounded-xl px-3 py-2 hover:bg-white/[0.04]">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 lg:grid-cols-[minmax(0,1fr)_repeat(4,6.5rem)_auto]">
        <span className="min-w-0">
          <span className="block truncate text-[13.5px] text-fg">{c.campaign_name}</span>
          {c.campaign_status && <span className={cn('text-[11px]', /paused|stopped/i.test(c.campaign_status) ? 'text-amber' : 'text-fg-46')}>{c.campaign_status}</span>}
        </span>
        <span className="hidden text-right lg:block"><Stat n={c.queued} label="queued" tone="text-cyan" /></span>
        <span className="hidden text-right lg:block"><Stat n={c.stopped} label="stopped" tone="text-amber" /></span>
        <span className="hidden text-right lg:block"><Stat n={c.active} label="in Instantly" tone="text-green" /></span>
        <span className="hidden text-right lg:block"><Stat n={c.finished} label="done" tone="text-fg-70" /></span>
        <span className="flex items-center justify-end gap-1">
          {c.queued > 0 && (
            <Button size="xs" variant={armed ? 'destructive' : 'ghost'} disabled={busy} onClick={() => void stop()} title="Take the queued leads out of the rotation now. Leads already in Instantly keep going.">
              <Square /> {armed ? `Stop ${fmt.format(c.queued)}?` : 'Stop'}
            </Button>
          )}
          {c.stopped > 0 && (
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => void file('restart')} title="Put the stopped leads back in the queue (asks for your tap)">
              <Play /> Restart
            </Button>
          )}
          {c.queued > 0 && targets.length > 0 && (
            <Button size="xs" variant="ghost" aria-pressed={moving} disabled={busy} onClick={() => setMoving((m) => !m)} title="Send the queued leads to another campaign instead (asks for your tap)">
              <ArrowRightLeft /> Move
            </Button>
          )}
        </span>
        <span className="col-span-2 flex flex-wrap gap-x-4 lg:hidden">
          <Stat n={c.queued} label="queued" tone="text-cyan" />
          <Stat n={c.stopped} label="stopped" tone="text-amber" />
          <Stat n={c.active} label="in Instantly" tone="text-green" />
          <Stat n={c.finished} label="done" tone="text-fg-70" />
        </span>
      </div>
      {moving && (
        <div className="flex flex-wrap items-center gap-2 pl-0.5">
          <span className="text-[12px] text-fg-46">Move {fmt.format(c.queued)} queued to</span>
          <SimpleSelect size="sm" aria-label="Move to campaign" value={to} onValueChange={setTo} options={[{ value: '', label: 'Pick a campaign' }, ...targets]} className="w-64" />
          <Button size="xs" disabled={!to || busy} onClick={() => void file('move')}>
            Request move
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setMoving(false)}>
            Cancel
          </Button>
        </div>
      )}
    </li>
  )
}

/**
 * Rotate → Pushes: every push in the lead bank, by source list and campaign.
 * Stop takes a push's queued leads out of the rotation now (restartable);
 * Restart and Move file a `bank_queue` approval. Leads already in Instantly
 * are never touched here.
 */
export function BankPushes() {
  const { data, error, mutate } = useSWR<PushesPayload>('/api/rotation/pushes', fetchJson, { refreshInterval: 60_000 })
  if (error && !data) return <p className="text-[12px] text-fg-46">Couldn&apos;t load the pushes.</p>
  if (!data) return <div className="h-28 animate-pulse rounded-2xl bg-(--glass-fill)" aria-label="Loading pushes" />
  const live = data.pushes.filter((g) => g.queued > 0 || g.stopped > 0 || g.active > 0)

  return (
    <section aria-label="Pushes" className="flex flex-col gap-3 rounded-2xl bg-(--glass-fill) p-4 backdrop-blur-xl sm:p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2 className="text-[15px] font-semibold text-fg">Pushes</h2>
        <p className="text-[11.5px] text-fg-46">Stop takes queued leads out of the rotation now. Restart and Move wait for your tap. Leads already in Instantly are never touched.</p>
      </header>
      {live.length === 0 && <p className="text-[12.5px] text-fg-46">No pushes in the rotation.</p>}
      <div className="flex flex-col gap-4">
        {live.map((g) => (
          <div key={g.key} className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <p className="min-w-0 truncate text-[12.5px] font-medium text-fg">{g.name}</p>
              {g.source_job_id && <PreviewLeadsButton jobId={g.source_job_id} name={g.name} />}
              <span className="font-mono text-[11px] text-fg-46 tabular-nums">
                {[day(g.first_banked_at) && `banked ${day(g.first_banked_at)}`, `${fmt.format(g.queued)} queued`, g.stopped ? `${fmt.format(g.stopped)} stopped` : null, `${fmt.format(g.active)} in Instantly`].filter(Boolean).join(' · ')}
              </span>
            </div>
            <ul className="flex flex-col gap-1">
              {g.campaigns.map((c) => (
                <CampaignRow key={c.campaign_id} group={g} c={c} campaigns={data.campaigns} onDone={() => void mutate()} />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  )
}
