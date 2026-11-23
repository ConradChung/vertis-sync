'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { Button } from '@/components/ui/button'
import { fetchJson } from '@/hooks/fetcher'
import { sendJson } from '@/lib/validate/client'
import { cn } from '@/lib/utils'
import type { CheckId, CheckResult, EdgePresence, HealthRun, PresenceRow } from '@/lib/health/model'

interface HealthState {
  vercel: PresenceRow[]
  edge: EdgePresence
  slack_test_channel: string | null
  last: HealthRun | null
}

const CHECK_LABEL: Record<CheckId, string> = {
  apify: 'Apify token valid',
  telegram: 'Telegram send',
  slack: 'Slack post to the test channel',
  worker: 'Railway worker reachable',
}

const fmtTime = (iso: string) => new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })

/**
 * Settings → Config health. Which secret names are set (Vercel and edge
 * functions; names only, never values) and, on "Run checks" only, four live
 * checks: Apify token, a Telegram send, a Slack post to the test channel
 * (never #sales) and the Railway worker's /health.
 */
export function ConfigHealth() {
  const { data, error, mutate } = useSWR<HealthState>('/api/settings/health', fetchJson)
  const [state, setState] = useState<'idle' | 'running' | 'error'>('idle')

  async function run() {
    setState('running')
    const r = await sendJson<HealthRun>('/api/settings/health', {}, { method: 'POST', timeoutMs: 60_000 })
    if (r.status === 200 && r.body?.results) {
      await mutate(data ? { ...data, last: r.body } : undefined, { revalidate: true })
      setState('idle')
    } else setState('error')
  }

  const last = data?.last ?? null
  const channel = data?.slack_test_channel || 'lume-health'

  return (
    <div className="flex flex-col gap-10">
      <section className="flex max-w-3xl flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold text-fg">Live checks</h2>
            <p className="mt-1 text-[13px] text-fg-70">
              Runs only when you click. Sends one Telegram message and one Slack message to #{channel}; never posts to #sales.
            </p>
          </div>
          <Button onClick={() => void run()} disabled={state === 'running'}>
            {state === 'running' ? 'Running…' : 'Run checks'}
          </Button>
        </div>
        <p className="text-[12px] text-fg-46" role="status">
          {last ? `Last checked ${fmtTime(last.checked_at)}.` : 'Not checked yet.'}
          {state === 'error' && ' Could not run the checks. Try again.'}
        </p>
        {last && (
          <ul className="surface flex flex-col divide-y divide-border rounded-lg">
            {(Object.keys(CHECK_LABEL) as CheckId[]).map((id) => (
              <CheckRow key={id} label={CHECK_LABEL[id]} result={last.results[id]} />
            ))}
          </ul>
        )}
      </section>

      <section className="flex max-w-3xl flex-col gap-4">
        <div>
          <h2 className="text-[15px] font-semibold text-fg">Required secrets</h2>
          <p className="mt-1 text-[13px] text-fg-70">Names only. Lume reads whether each is set, never its value.</p>
        </div>
        {error && <p className="text-[13px] text-fg-70">Could not load config health.</p>}
        {!data && !error && <p className="text-[13px] text-fg-46">Loading…</p>}
        {data && (
          <div className="grid gap-6 md:grid-cols-2">
            <NameList title="Vercel (Lume)" rows={data.vercel} />
            <NameList title="Edge functions" rows={data.edge.names} note={data.edge.ok ? null : data.edge.error} />
          </div>
        )}
      </section>
    </div>
  )
}

function CheckRow({ label, result }: { label: string; result: CheckResult }) {
  return (
    <li className="flex items-start gap-3 px-4 py-3 text-[13px]">
      <StatusDot ok={result.ok} />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-fg">{label}</div>
        <div className="break-words text-fg-70">{result.detail}</div>
      </div>
      <span className="shrink-0 font-mono text-[12px] text-fg-46">{result.ms} ms</span>
    </li>
  )
}

function NameList({ title, rows, note }: { title: string; rows: PresenceRow[]; note?: string | null }) {
  const missing = rows.filter((r) => r.required && !r.present).length
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-[13px] font-semibold text-fg">
        {title}
        <span className="ml-2 font-normal text-fg-46">{note ? 'unknown' : missing ? `${missing} required missing` : 'all required set'}</span>
      </h3>
      {note && <p className="text-[12px] text-fg-70">{note}</p>}
      <ul className="surface flex flex-col divide-y divide-border rounded-lg">
        {rows.map((r) => (
          <li key={r.name} className="flex items-center gap-3 px-3 py-2 text-[12px]">
            <StatusDot ok={r.present} muted={!r.required || !!note} />
            <span className="min-w-0 flex-1 truncate font-mono text-fg">{r.name}</span>
            <span className="text-fg-46">{note ? '—' : r.present ? 'set' : r.required ? 'missing' : 'not set (optional)'}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function StatusDot({ ok, muted = false }: { ok: boolean; muted?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn('mt-1 size-2 shrink-0 rounded-full', ok ? 'bg-emerald-500' : muted ? 'bg-fg-24' : 'bg-red-500')}
    />
  )
}
