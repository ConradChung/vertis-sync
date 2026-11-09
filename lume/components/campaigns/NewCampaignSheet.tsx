'use client'

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import Link from 'next/link'
import useSWR from 'swr'
import { Clock3, Loader2, Sparkles } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/validate/Switch'
import { fetchJson } from '@/hooks/fetcher'
import { sendJson } from '@/lib/validate/client'
import { verticalShort } from '@/lib/campaigns/suggest'
import { DEFAULT_DAILY_LIMIT, DEFAULT_SCHEDULE, scheduleSummary } from '@/lib/campaigns/newCampaignPayload'
import type { SuggestResponse } from '@/lib/campaigns/suggestData'

/**
 * New campaign (from scratch). Pick a lead source and Lume pre-fills the tag,
 * template, name, inboxes, schedule and daily limit from the leads (GET
 * /api/campaigns/suggest), with the why under each field. Submitting files a
 * `new_campaign` pending action (POST /api/campaigns/new): nothing is created
 * until the owner confirms it, and then only as a draft.
 *
 * `jobId` (Progress → Campaign step): pre-filled from that job, which is
 * picked for the new campaign once it exists.
 */

export interface NewCampaignSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  jobId?: string | null
  listId?: string | null
}

type FormState = {
  vertical_id: string
  template_id: string
  name: string
  email_list: string[]
  daily_limit: number
  stop_on_reply: boolean
  no_location: boolean
  campaign_schedule: unknown
}

type Done = { kind: 'created'; id: string; summary: string } | { kind: 'duplicate'; id: string | null }

const srcKey = (jobId?: string | null, listId?: string | null) => (jobId ? `job:${jobId}` : listId ? `list:${listId}` : '')

function suggestUrl(source: string): string {
  const [kind, id] = source.split(':')
  if (kind === 'job' && id) return `/api/campaigns/suggest?job_id=${id}`
  if (kind === 'list' && id) return `/api/campaigns/suggest?list_id=${id}`
  return '/api/campaigns/suggest'
}

const ERRORS: Record<string, string> = {
  unknown_inboxes: 'Some inboxes are not Instantly accounts anymore.',
  unknown_template: 'That template no longer exists.',
  unknown_vertical: 'That tag no longer exists.',
  name_taken: 'A campaign with that name already exists in Instantly.',
  nolocation_needs_template: 'The No-Location sibling needs a template without {{location}} for this tag.',
  nolocation_not_needed: 'This template never uses {{location}}, so no sibling is needed.',
  instantly_not_configured: 'Instantly is not connected.',
  instantly_unavailable: "Instantly didn't answer. Try again in a minute.",
  invalid_payload: 'Something in the form is missing or invalid.',
  network: 'Network error. Nothing was filed.',
}

function fromSuggestion(d: SuggestResponse): FormState {
  const s = d.suggestion
  return {
    vertical_id: s.vertical_id ?? '',
    template_id: s.template_id ?? '',
    name: s.name,
    email_list: s.settings?.email_list ?? [],
    daily_limit: s.settings?.daily_limit ?? DEFAULT_DAILY_LIMIT,
    stop_on_reply: s.settings?.stop_on_reply ?? true,
    no_location: s.no_location.advisable,
    campaign_schedule: s.settings?.campaign_schedule ?? DEFAULT_SCHEDULE,
  }
}

export function NewCampaignSheet(p: NewCampaignSheetProps) {
  return (
    <Sheet open={p.open} onOpenChange={p.onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto border-0 bg-black/85 backdrop-blur-2xl sm:max-w-lg">
        {p.open && <NewCampaignForm key={srcKey(p.jobId, p.listId)} {...p} />}
      </SheetContent>
    </Sheet>
  )
}

function Why({ children }: { children?: string | null }) {
  if (!children) return null
  return (
    <span className="flex items-start gap-1 text-[11px] leading-snug text-fg-46">
      <Sparkles aria-hidden className="mt-[2px] size-3 shrink-0 text-violet-soft/70" />
      {children}
    </span>
  )
}

export function NewCampaignForm({ jobId, listId, onOpenChange }: NewCampaignSheetProps) {
  const id = useId()
  const [source, setSource] = useState(srcKey(jobId, listId))
  const { data, error, isLoading } = useSWR<SuggestResponse>(suggestUrl(source), fetchJson, { revalidateOnFocus: false })
  const [v, setV] = useState<FormState | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState<Done | null>(null)
  const prefilled = useRef<string | null>(null)
  const autoName = useRef<string>('')

  // Pre-fill once per lead source; the owner's edits stay until the source changes.
  useEffect(() => {
    if (!data) return
    const key = `${source}|${data.source?.id ?? ''}`
    if (prefilled.current === key) return
    prefilled.current = key
    const next = fromSuggestion(data)
    autoName.current = next.name
    setV(next)
  }, [data, source])

  const templates = useMemo(() => data?.options.templates ?? [], [data])
  const template = templates.find((t) => t.id === v?.template_id) ?? null
  const accounts = data?.options.accounts ?? []
  const verticalName = (vid: string) => data?.options.verticals.find((x) => x.id === vid)?.name ?? null
  const sug = data?.suggestion
  const showNoLocation = !!template?.uses_location && (sug?.no_location.advisable || v?.no_location)
  const valid = !!v && v.name.trim().length > 0 && v.name.length <= 200 && !!v.template_id && v.email_list.length > 0 && v.daily_limit >= 1

  function setTag(vid: string) {
    if (!v) return
    const next = { ...v, vertical_id: vid }
    const own = templates.find((t) => t.vertical_id === vid && !t.no_location)
    if (own) next.template_id = own.id
    // Rename only a name Lume wrote: swap the tag prefix.
    if (v.name === autoName.current) {
      const oldShort = sug?.vertical_name ? verticalShort(sug.vertical_name) : 'New campaign'
      const newName = verticalName(vid)
      const swapped = v.name.startsWith(oldShort) ? `${newName ? verticalShort(newName) : 'New campaign'}${v.name.slice(oldShort.length)}` : v.name
      next.name = swapped
      autoName.current = swapped
    }
    setV(next)
  }

  function toggleInbox(email: string) {
    if (!v) return
    setV({ ...v, email_list: v.email_list.includes(email) ? v.email_list.filter((e) => e !== email) : [...v.email_list, email] })
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!v || !valid || busy) return
    setBusy(true)
    setErr(null)
    const [kind, sid] = source.split(':')
    const body = {
      name: v.name.trim(),
      ...(v.vertical_id ? { vertical_id: v.vertical_id } : {}),
      template_id: v.template_id,
      email_list: v.email_list,
      campaign_schedule: v.campaign_schedule,
      daily_limit: v.daily_limit,
      stop_on_reply: v.stop_on_reply,
      ...(kind === 'job' && sid ? { job_id: sid } : {}),
      ...(kind === 'list' && sid ? { list_id: sid } : {}),
      ...(showNoLocation && v.no_location ? { no_location_sibling: true } : {}),
    }
    const r = await sendJson<{ action?: { id: string; summary: string }; error?: string; existing_id?: string | null; problems?: string[] }>('/api/campaigns/new', body)
    setBusy(false)
    if (r.status === 201 && r.body?.action) setDone({ kind: 'created', id: r.body.action.id, summary: r.body.action.summary })
    else if (r.status === 409 && r.body?.error === 'duplicate') setDone({ kind: 'duplicate', id: r.body.existing_id ?? null })
    else {
      const code = r.status === 0 ? 'network' : (r.body?.error ?? `HTTP ${r.status}`)
      const extra = r.body?.problems?.length ? ` (${r.body.problems.slice(0, 3).join(', ')})` : ''
      setErr(`${ERRORS[code] ?? code}${extra}`)
    }
  }

  const sourceOptions = useMemo(() => {
    const opts = [{ value: '', label: 'No lead source — defaults only' }]
    const jobs = data?.options.sources.jobs ?? []
    const lists = data?.options.sources.lists ?? []
    const cur = data?.source
    if (cur && !(cur.kind === 'job' ? jobs : lists).some((x) => x.id === cur.id)) opts.push({ value: `${cur.kind}:${cur.id}`, label: `${cur.kind === 'job' ? 'Validated' : 'List'} · ${cur.label}` })
    for (const j of jobs) opts.push({ value: `job:${j.id}`, label: `Validated · ${j.label}` })
    for (const l of lists) opts.push({ value: `list:${l.id}`, label: `List · ${l.label} · ${l.rows.toLocaleString('en-US')} rows` })
    return opts
  }, [data])

  if (done) {
    return (
      <div className="flex min-h-full flex-col gap-4 px-5 pt-5">
        <SheetHeader className="p-0">
          <SheetTitle>{done.kind === 'created' ? 'Sent for your confirmation' : 'Already awaiting confirmation'}</SheetTitle>
          <SheetDescription className="text-fg-46">
            {done.kind === 'created'
              ? 'Nothing is created in Instantly until you confirm. Then it is made as a draft — it never launches on its own.'
              : 'A campaign with this name (or for this list) is already waiting for your tap.'}
          </SheetDescription>
        </SheetHeader>
        {done.kind === 'created' && (
          <p className="flex items-start gap-2 text-[13px] text-fg-70">
            <Clock3 aria-hidden className="mt-[3px] size-3.5 shrink-0 text-violet-soft" />
            {done.summary}
          </p>
        )}
        <div className="flex items-center gap-2">
          {done.id && (
            <Link href={`/actions/${done.id}`} className={buttonVariants({ size: 'sm' })}>
              Review and confirm →
            </Link>
          )}
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </div>
    )
  }

  const label = 'flex flex-col gap-1.5 text-[12px] text-fg-70'
  const field = 'h-9 text-[13px]'

  return (
    <form onSubmit={submit} className="flex min-h-full flex-col" aria-label="New campaign">
      <SheetHeader className="px-5 pt-5">
        <SheetTitle>New campaign</SheetTitle>
        <SheetDescription className="text-fg-46">Lume reads the leads and suggests the setup. You confirm before anything is created.</SheetDescription>
      </SheetHeader>
      <div className="flex flex-col gap-5 px-5 pb-6">
        <div className={label}>
          <label htmlFor={`${id}-src`}>Lead source</label>
          <SimpleSelect id={`${id}-src`} value={source} onValueChange={setSource} options={sourceOptions} className={field} />
          {data?.profile && (
            <span className="text-[11px] text-fg-46">
              Read {data.profile.rows.toLocaleString('en-US')} rows
              {data.profile.industries[0] ? ` · mostly ${data.profile.industries[0].value}` : ''}
              {data.profile.roles[0] ? ` · ${Math.round(data.profile.roles[0].share * 100)}% ${data.profile.roles[0].value}s` : ''}
            </span>
          )}
        </div>

        {error && !data && (
          <p role="alert" className="text-[12px] text-red">
            Couldn&apos;t read the suggestions. You can still pick a source again.
          </p>
        )}
        {(isLoading || !v) && !error && (
          <p className="flex items-center gap-2 text-[12px] text-fg-46">
            <Loader2 className="size-3.5 animate-spin" aria-hidden /> Reading the leads…
          </p>
        )}

        {v && data && (
          <>
            <div className={label}>
              <label htmlFor={`${id}-tag`}>Tag</label>
              <SimpleSelect
                id={`${id}-tag`}
                value={v.vertical_id}
                onValueChange={setTag}
                className={field}
                options={[{ value: '', label: 'No tag' }, ...data.options.verticals.map((x) => ({ value: x.id, label: x.name }))]}
              />
              <Why>{v.vertical_id === sug?.vertical_id ? sug?.vertical_why : data.verticals.find((x) => x.id === v.vertical_id)?.why}</Why>
            </div>

            <div className="flex flex-col gap-1.5">
              <div className={label}>
                <label htmlFor={`${id}-tpl`}>Template</label>
                <SimpleSelect
                  id={`${id}-tpl`}
                  value={v.template_id}
                  onValueChange={(template_id) => setV({ ...v, template_id })}
                  className={field}
                  options={
                    templates.length
                      ? templates.map((t) => ({ value: t.id, label: t.name }))
                      : [{ value: '', label: 'No templates yet' }]
                  }
                />
              </div>
              <Why>{template?.why || (v.template_id === sug?.template_id ? sug?.template_why : null)}</Why>
              {template?.preview && (
                <div className="mt-1 rounded-xl bg-white/[0.035] px-3.5 py-3" aria-label="Sequence preview">
                  <p className="text-[11px] tracking-wide text-fg-46 uppercase">
                    {template.preview.steps} step{template.preview.steps === 1 ? '' : 's'} · {template.preview.variants} variant{template.preview.variants === 1 ? '' : 's'} on step 1
                  </p>
                  {template.preview.subject && <p className="mt-1.5 text-[13px] font-medium text-fg">{template.preview.subject}</p>}
                  <p className="mt-1 line-clamp-6 text-[12px] leading-relaxed whitespace-pre-line text-fg-70">{template.preview.body}</p>
                </div>
              )}
            </div>

            <div className={label}>
              <label htmlFor={`${id}-name`}>Name</label>
              <Input id={`${id}-name`} className={field} value={v.name} maxLength={200} onChange={(e) => setV({ ...v, name: e.target.value })} />
              {sug?.segment && v.name === autoName.current && <Why>{`Segment from the leads: ${sug.segment}`}</Why>}
            </div>

            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1.5 flex w-full items-center justify-between text-[12px] text-fg-70">
                <span>
                  Inboxes <span className="text-fg-46">({v.email_list.length} selected)</span>
                </span>
                {accounts.length > 0 && (
                  <button
                    type="button"
                    className="text-[11px] text-violet-soft hover:text-fg"
                    onClick={() => setV({ ...v, email_list: v.email_list.length === accounts.length ? [] : accounts.map((a) => a.email) })}
                  >
                    {v.email_list.length === accounts.length ? 'None' : 'All'}
                  </button>
                )}
              </legend>
              {accounts.length === 0 ? (
                <p className="text-[12px] text-fg-46">{data.instantly.configured ? "Couldn't read the Instantly inboxes." : 'Instantly is not connected.'}</p>
              ) : (
                <div className="max-h-48 overflow-y-auto rounded-xl bg-white/[0.035] py-1">
                  {accounts.map((a) => (
                    <label key={a.email} className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-[12px] text-fg-70 hover:bg-white/[0.04]">
                      <input type="checkbox" className="size-3.5 accent-[var(--primary)]" checked={v.email_list.includes(a.email)} onChange={() => toggleInbox(a.email)} />
                      <span className="min-w-0 flex-1 truncate text-fg">{a.email}</span>
                      {a.warmup_score !== null && <span className="text-[11px] text-fg-46">{a.warmup_score}</span>}
                    </label>
                  ))}
                </div>
              )}
              <Why>{sug?.settings?.why}</Why>
            </fieldset>

            <div className="grid grid-cols-[1fr_auto] items-end gap-3">
              <div className="flex flex-col gap-1.5 text-[12px] text-fg-70">
                Schedule
                <span className="text-[13px] text-fg">{scheduleSummary(v.campaign_schedule)}</span>
              </div>
              <div className={label}>
                <label htmlFor={`${id}-limit`}>Daily limit</label>
                <Input
                  id={`${id}-limit`}
                  type="number"
                  min={1}
                  max={10000}
                  className={`${field} w-24`}
                  value={v.daily_limit}
                  onChange={(e) => setV({ ...v, daily_limit: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
                />
              </div>
            </div>

            <div className="-mx-2 flex flex-col gap-1">
              <Switch label="Stop on reply" checked={v.stop_on_reply} onChange={(stop_on_reply) => setV({ ...v, stop_on_reply })} />
              {showNoLocation && (
                <Switch
                  label="Also create a No-Location sibling"
                  hint={sug?.no_location.why}
                  checked={v.no_location}
                  onChange={(no_location) => setV({ ...v, no_location })}
                />
              )}
            </div>

            {err && (
              <p role="alert" className="text-[12px] text-red">
                {err}
              </p>
            )}
            <div className="flex items-center gap-3">
              <Button type="submit" size="sm" disabled={!valid || busy}>
                {busy ? 'Sending…' : 'Send for confirmation'}
              </Button>
              <span className="text-[11px] text-fg-46">Created as a draft after you confirm.</span>
            </div>
          </>
        )}
      </div>
    </form>
  )
}
