'use client'

import { useState, type FormEvent } from 'react'
import Link from 'next/link'
import { Loader2, MapPin } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { GlassCard } from '@/components/ui/glass-card'
import { Input } from '@/components/ui/input'
import { LA_COUNTY_AREAS } from '@/lib/maps/areas'
import { MAPS_DEFAULT_PER_SEARCH } from '@/lib/maps/scrape'
import { ACTOR_RUN_CAP_USD } from '@/lib/apify/pricing'
import { buildMapsSheetFrom, isRunId, mapsErrorMessage, requestMapsScrape, sheetLine } from '@/lib/maps/client'

type Status =
  | { state: 'idle' }
  | { state: 'busy' }
  | { state: 'done'; text: string; href: string; linkText: string }
  | { state: 'error'; text: string }

function Line({ status }: { status: Status }) {
  return (
    <p role="status" aria-live="polite" className="min-h-[18px] text-[12px]">
      {status.state === 'done' && (
        <span className="text-green">
          {status.text}{' '}
          <Link href={status.href} className="text-violet-soft underline-offset-2 hover:text-fg hover:underline">
            {status.linkText}
          </Link>
        </span>
      )}
      {status.state === 'error' && <span className="text-amber">{status.text}</span>}
    </p>
  )
}

const Spinner = () => <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />

/**
 * GTM-12: the LA County Google Maps lane. Two steps, each its own button:
 * request the scrape (a run_actor approval: nothing runs until Confirm), then,
 * once the run has finished, build the Maps sheet from its run id (free).
 */
export function MapsCard() {
  const [scrape, setScrape] = useState<Status>({ state: 'idle' })
  const [sheet, setSheet] = useState<Status>({ state: 'idle' })
  const [runId, setRunId] = useState('')

  async function request() {
    if (scrape.state === 'busy') return
    setScrape({ state: 'busy' })
    const a = await requestMapsScrape()
    if (a.status === 201 && a.body?.ok) {
      setScrape({ state: 'done', text: `Filed for approval: ${a.body.action.summary.split('\n')[0]}.`, href: `/actions/${a.body.action.id}`, linkText: 'Review and confirm →' })
    } else {
      const existing = (a.body as { existing_id?: string } | null)?.existing_id
      if (a.status === 409 && existing) setScrape({ state: 'done', text: mapsErrorMessage(a), href: `/actions/${existing}`, linkText: 'Open it →' })
      else setScrape({ state: 'error', text: mapsErrorMessage(a) })
    }
  }

  async function build(e: FormEvent) {
    e.preventDefault()
    if (!isRunId(runId) || sheet.state === 'busy') return
    setSheet({ state: 'busy' })
    const a = await buildMapsSheetFrom(runId)
    if (a.status === 201 && a.body?.ok) {
      setSheet({ state: 'done', text: sheetLine(a.body), href: a.body.href, linkText: 'Open the sheet →' })
      setRunId('')
    } else {
      setSheet({ state: 'error', text: mapsErrorMessage(a) })
    }
  }

  return (
    <GlassCard className="gap-3 px-[18px]" role="region" aria-label="Google Maps intake">
      <div className="flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-(--glass-border) bg-(--glass-fill) text-foreground" aria-hidden>
          <MapPin className="size-4" />
        </span>
        <div className="min-w-0">
          <h2 className="text-[14px] font-semibold text-fg">Google Maps · LA County property managers</h2>
          <p className="text-[12px] text-fg-46">
            {LA_COUNTY_AREAS.length} searches (“property management in …”), {MAPS_DEFAULT_PER_SEARCH} places each, no paid add-ons. Waits for your Confirm; Apify stops at ${ACTOR_RUN_CAP_USD}.
          </p>
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="flex flex-col gap-2">
          <span className="text-[11px] text-fg-46">1 · Scrape</span>
          <Button type="button" onClick={request} disabled={scrape.state === 'busy'} aria-busy={scrape.state === 'busy' || undefined} className="self-start">
            {scrape.state === 'busy' ? <Spinner /> : null}
            Request the scrape
          </Button>
          <Line status={scrape} />
        </div>
        <form onSubmit={build} className="flex flex-col gap-2">
          <label htmlFor="maps-run-id" className="text-[11px] text-fg-46">
            2 · Build the sheet from the finished run
          </label>
          <div className="flex gap-2">
            <Input
              id="maps-run-id"
              value={runId}
              onChange={(e) => setRunId(e.target.value)}
              placeholder="Apify run id"
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-[12px]"
              disabled={sheet.state === 'busy'}
            />
            <Button type="submit" disabled={!isRunId(runId) || sheet.state === 'busy'} aria-busy={sheet.state === 'busy' || undefined}>
              {sheet.state === 'busy' ? <Spinner /> : null}
              Build
            </Button>
          </div>
          <Line status={sheet} />
        </form>
      </div>
    </GlassCard>
  )
}
