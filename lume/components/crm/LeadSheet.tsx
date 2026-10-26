'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { format } from 'date-fns'
import { Check, Copy, ExternalLink, Hourglass, Reply, ThumbsDown, ThumbsUp } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { DatePicker, parseIsoDate } from '@/components/ui/date-picker'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { CloseDialog } from '@/components/crm/CloseDialog'
import { LeadAvatar, RelTime, SourceBadge } from '@/components/crm/parts'
import { useCrmDeal } from '@/hooks/useCrm'
import { patchDeal, patchErrorText, replyHref, type PatchBody } from '@/lib/crm/client'
import { requiresApproval } from '@/lib/crm/stages'
import { replyTextOf, timelineLabel } from '@/lib/crm/timeline'
import type { CrmActivity, CrmDealDetail } from '@/lib/crm/types'

const OWNER_OPTIONS = ['me', 'agent']

/** Right drawer for one deal: header controls, Timeline / Thread / Notes / Fields, next action + reply footer. */
export function LeadSheet({ dealId, onOpenChange, onChanged }: { dealId: string | null; onOpenChange: (open: boolean) => void; onChanged: () => void }) {
  return (
    <Sheet open={dealId !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto p-0 sm:max-w-xl">
        {dealId && <LeadSheetBody key={dealId} dealId={dealId} onChanged={onChanged} />}
      </SheetContent>
    </Sheet>
  )
}

function LeadSheetBody({ dealId, onChanged }: { dealId: string; onChanged: () => void }) {
  const { data, error, mutate } = useCrmDeal(dealId)
  const [closing, setClosing] = useState<{ stage: 'Won' | 'Lost'; label: string; preset?: string } | null>(null)
  const [busy, setBusy] = useState(false)

  if (error && !data) {
    return (
      <SheetHeader className="p-5">
        <SheetTitle>Couldn&apos;t load this lead</SheetTitle>
        <SheetDescription>{error.message}</SheetDescription>
      </SheetHeader>
    )
  }
  if (!data) {
    return (
      <div className="space-y-3 p-5" aria-busy>
        <SheetTitle className="sr-only">Loading lead</SheetTitle>
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  const d = data.deal
  const label = d.name ?? d.email

  async function save(body: PatchBody, okText?: string) {
    setBusy(true)
    const a = await patchDeal(dealId, body)
    setBusy(false)
    if (a.status === 202 && a.body && 'pending_action_id' in a.body) {
      toast('Sent for approval', {
        description: 'Approve in Telegram or Pending approvals; the deal moves after that.',
        action: { label: 'Open', onClick: () => window.open(`/actions/${(a.body as { pending_action_id: string }).pending_action_id}`, '_self') },
      })
    } else if (a.status === 200) {
      if (okText) toast(okText)
    } else {
      toast.error(patchErrorText(a))
    }
    await mutate()
    onChanged()
    return a.status === 200 || a.status === 202
  }

  const moveTo = (stage: string, preset?: string) => {
    if (requiresApproval(stage)) setClosing({ stage, label, preset })
    else void save({ stage }, `Moved to ${stage}`)
  }

  return (
    <>
      <SheetHeader className="gap-3 border-b border-border p-5">
        <div className="flex items-start gap-3">
          <LeadAvatar name={d.name} email={d.email} className="size-10 text-sm" />
          <div className="min-w-0 flex-1">
            <SheetTitle className="truncate text-lg">{label}</SheetTitle>
            <SheetDescription className="truncate">
              {[d.company, d.city].filter(Boolean).join(' · ') || 'No company on file'}
              {data.campaign_name ? ` — ${data.campaign_name}` : ''}
            </SheetDescription>
            <div className="mt-1.5 flex items-center gap-1.5">
              <span className="truncate font-mono text-xs text-foreground">{d.email}</span>
              <CopyButton text={d.email} />
              <SourceBadge source={d.source} />
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <SimpleSelect
            aria-label="Stage"
            size="sm"
            value={d.stage}
            disabled={busy || !!data.awaiting_close}
            onValueChange={(v) => v && v !== d.stage && moveTo(v)}
            options={data.stages.map((s) => ({ value: s.name, label: s.name }))}
          />
          <SimpleSelect
            aria-label="Owner"
            size="sm"
            value={d.owner ?? ''}
            disabled={busy}
            onValueChange={(v) => void save({ owner: v || null })}
            options={[{ value: '', label: 'Unassigned' }, ...[...new Set([...OWNER_OPTIONS, ...(d.owner ? [d.owner] : [])])].map((o) => ({ value: o, label: o === 'me' ? 'Me' : o === 'agent' ? 'Agent' : o }))]}
          />
        </div>
        {data.awaiting_close && (
          <Link href={`/actions/${data.awaiting_close}`} className="inline-flex items-center gap-1.5 text-xs text-foreground underline decoration-primary underline-offset-4">
            <Hourglass size={14} strokeWidth={1.75} aria-hidden /> Won/Lost waiting for approval — review
          </Link>
        )}
        {d.won_lost_reason && (d.stage === 'Won' || d.stage === 'Lost') && (
          <p className="text-xs text-muted-foreground">
            {d.stage}: {d.won_lost_reason}
          </p>
        )}
      </SheetHeader>

      <Tabs defaultValue="timeline" className="flex-1 px-5 pt-4">
        <TabsList>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="thread">Thread</TabsTrigger>
          <TabsTrigger value="notes">Notes</TabsTrigger>
          <TabsTrigger value="fields">Fields</TabsTrigger>
        </TabsList>
        <TabsContent value="timeline" className="pt-3 pb-4">
          <Timeline activities={data.activities} />
        </TabsContent>
        <TabsContent value="thread" className="pt-3 pb-4">
          <Thread activities={data.activities} />
        </TabsContent>
        <TabsContent value="notes" className="pt-3 pb-4">
          <Notes dealId={dealId} initial={d.notes ?? ''} onSaved={() => void mutate()} />
        </TabsContent>
        <TabsContent value="fields" className="pt-3 pb-4">
          <Fields data={data} />
        </TabsContent>
      </Tabs>

      <SheetFooter className="gap-3 border-t border-border p-5">
        <NextAction key={`${d.next_action_at}|${d.next_action}`} at={d.next_action_at} text={d.next_action} busy={busy} onSave={(b) => save(b, 'Next action saved')} />
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" render={<a href={replyHref(d.source, d.email)} target="_blank" rel="noreferrer" />} nativeButton={false}>
            <Reply /> Reply <ExternalLink className="opacity-60" />
          </Button>
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="outline" disabled={busy || d.stage === 'Interested'} onClick={() => moveTo('Interested')}>
              <ThumbsUp /> Mark interested
            </Button>
            <Button size="sm" variant="ghost" disabled={busy || !!data.awaiting_close} onClick={() => moveTo('Lost', 'Not interested')}>
              <ThumbsDown /> Not interested
            </Button>
          </div>
        </div>
      </SheetFooter>

      <CloseDialog
        key={closing ? `${closing.stage}-${closing.preset ?? ''}` : 'none'}
        target={closing}
        initialReason={closing?.preset}
        busy={busy}
        onCancel={() => setClosing(null)}
        onConfirm={async (reason) => {
          const stage = closing!.stage
          setClosing(null)
          await save({ stage, reason })
        }}
      />
    </>
  )
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      aria-label="Copy email"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1200)
        })
      }}
      className="grid size-6 place-items-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      {done ? <Check size={14} strokeWidth={1.75} /> : <Copy size={14} strokeWidth={1.75} />}
    </button>
  )
}

function Timeline({ activities }: { activities: CrmActivity[] }) {
  if (!activities.length) return <p className="text-sm text-muted-foreground">No activity yet. Sends, opens, replies, bounces and stage changes land here.</p>
  return (
    <ol className="relative space-y-3 border-l border-border pl-4" aria-label="Timeline">
      {activities.map((a) => (
        <li key={a.id} className="relative">
          <span className="absolute top-1.5 -left-[21px] size-2 rounded-full bg-primary ring-4 ring-background" aria-hidden />
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm text-foreground">{timelineLabel(a)}</span>
            <RelTime iso={a.occurred_at} className="shrink-0" />
          </div>
          <div className="font-mono text-[11px] text-muted-foreground">{a.source}</div>
        </li>
      ))}
    </ol>
  )
}

function Thread({ activities }: { activities: CrmActivity[] }) {
  const msgs = activities
    .filter((a) => a.kind === 'replied' || a.kind === 'sent')
    .map((a) => ({ a, text: replyTextOf(a) }))
    .filter((m) => m.text)
    .reverse()
  if (!msgs.length) return <p className="text-sm text-muted-foreground">No messages captured yet. Replies arrive through the Instantly webhook.</p>
  return (
    <div className="space-y-3">
      {msgs.map(({ a, text }) => (
        <div key={a.id} className={a.kind === 'replied' ? 'mr-8 rounded-lg border border-border bg-(--glass-fill) p-3' : 'ml-8 rounded-lg bg-secondary p-3'}>
          <div className="mb-1 flex justify-between gap-2 text-[11px] text-muted-foreground">
            <span>{a.kind === 'replied' ? 'Lead' : 'You'}</span>
            <RelTime iso={a.occurred_at} />
          </div>
          <p className="text-sm whitespace-pre-wrap text-foreground">{text}</p>
        </div>
      ))}
    </div>
  )
}

/** Autosaves 800 ms after the last keystroke. */
function Notes({ dealId, initial, onSaved }: { dealId: string; initial: string; onSaved: () => void }) {
  const [value, setValue] = useState(initial)
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const last = useRef(initial)
  useEffect(() => {
    if (value === last.current) return
    const t = setTimeout(async () => {
      setState('saving')
      const a = await patchDeal(dealId, { notes: value })
      if (a.status === 200) {
        last.current = value
        setState('saved')
        onSaved()
      } else setState('error')
    }, 800)
    return () => clearTimeout(t)
  }, [value, dealId, onSaved])
  return (
    <div className="space-y-1.5">
      <Textarea value={value} onChange={(e) => setValue(e.target.value)} rows={10} maxLength={20_000} placeholder="Notes about this lead…" aria-label="Notes" />
      <p className="text-right font-mono text-[11px] text-muted-foreground" aria-live="polite">
        {state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : state === 'error' ? 'Not saved — keep typing to retry' : ''}
      </p>
    </div>
  )
}

const FIELD_KEYS: [string, string][] = [
  ['first_name', 'First name'],
  ['last_name', 'Last name'],
  ['company_name', 'Company'],
  ['company_domain', 'Domain'],
  ['website', 'Website'],
  ['location', 'Location'],
  ['operating_cities', 'Operating cities'],
  ['timezone', 'Timezone'],
  ['personalization', 'Personalization'],
  ['state', 'Lead bank state'],
  ['interest_status', 'Instantly interest'],
  ['email_open_count', 'Opens'],
  ['email_reply_count', 'Replies'],
  ['pushed_at', 'Pushed to Instantly'],
  ['created_at', 'Imported'],
]

function Fields({ data }: { data: CrmDealDetail }) {
  const lead = data.lead
  return (
    <dl className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-2 text-sm">
      <dt className="text-muted-foreground">Source</dt>
      <dd className="font-mono text-xs">{data.deal.source}</dd>
      <dt className="text-muted-foreground">Campaign</dt>
      <dd className="truncate">{data.campaign_name ?? <span className="font-mono text-xs">{data.deal.campaign_id}</span>}</dd>
      <dt className="text-muted-foreground">Lead bank id</dt>
      <dd className="font-mono text-xs tabular-nums">{data.deal.lead_id ?? '—'}</dd>
      {lead ? (
        FIELD_KEYS.filter(([k]) => lead[k] !== null && lead[k] !== undefined && lead[k] !== '').map(([k, l]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{l}</dt>
            <dd className={typeof lead[k] === 'number' || k.endsWith('_at') ? 'font-mono text-xs tabular-nums' : 'break-words'}>{String(lead[k])}</dd>
          </div>
        ))
      ) : (
        <p className="col-span-2 text-muted-foreground">No lead-bank row linked (ICP and enrichment fields come from there).</p>
      )}
    </dl>
  )
}

function NextAction({ at, text, busy, onSave }: { at: string | null; text: string | null; busy: boolean; onSave: (b: PatchBody) => Promise<boolean> }) {
  const [date, setDate] = useState(at ? format(new Date(at), 'yyyy-MM-dd') : '')
  const [what, setWhat] = useState(text ?? '')
  const dirty = date !== (at ? format(new Date(at), 'yyyy-MM-dd') : '') || what !== (text ?? '')
  return (
    <form
      className="flex w-full flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        const d = parseIsoDate(date)
        if (d) d.setHours(9, 0, 0, 0)
        void onSave({ next_action_at: d ? d.toISOString() : null, next_action: what.trim() || null })
      }}
    >
      <span className="eyebrow w-full">Next action</span>
      <DatePicker value={date} onChange={setDate} size="sm" aria-label="Next action date" className="w-40" />
      <Input value={what} onChange={(e) => setWhat(e.target.value)} maxLength={300} placeholder="e.g. Send case study" aria-label="Next action" className="h-7 min-w-0 flex-1 text-[13px]" />
      <Button size="sm" type="submit" disabled={busy || !dirty}>
        Save
      </Button>
    </form>
  )
}
