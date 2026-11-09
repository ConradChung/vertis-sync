'use client'

import { useId, type ReactNode } from 'react'
import useSWR from 'swr'
import { fetchJson } from '@/hooks/fetcher'
import type { BankStatus } from '@/lib/progress/bank'
import { BarrierPanel } from '@/components/validate/BarrierPanel'
import { CompanyReview } from '@/components/validate/CompanyReview'
import { GateActions } from '@/components/validate/GateCard'
import { Bar, JobProgressView } from '@/components/validate/JobProgress'
import { useJobReasons } from '@/hooks/useJob'
import type { GateRow, JobProgress } from '@/lib/db/types'
import { bankedCount, isBankRoute, STATE_WORD, type FlowNode, type PushRoute } from '@/lib/progress/flow'
import type { RunSummary } from '@/lib/progress/runs'
import type { ButtonSpec } from '@/lib/validate/actions'
import { gateKey } from '@/lib/validate/deepLink'
import { liveEta } from '@/lib/validate/eta'
import { sourceLabel } from '@/lib/validate/stats'
import { cn } from '@/lib/utils'

const fmt = new Intl.NumberFormat('en-US')

export interface StepGateProps {
  focusedKey: string | null
  busyKeys: ReadonlySet<string>
  countOpenKey: string | null
  pickerTick: number
  onAction: (gate: GateRow, spec: ButtonSpec, count?: number) => void
  onCountOpenChange: (key: string, open: boolean) => void
  onFocusGate: (key: string) => void
  blockedFor: (gate: GateRow) => Readonly<Record<string, string>> | undefined
}

export interface StepDetailProps extends StepGateProps {
  node: FlowNode
  /** 1-based position in the run's flow, and the flow's length. */
  index: number
  count: number
  run: RunSummary
  job: JobProgress | null
  /** instantly-push preview routing (lead bank vs direct); missing = direct. */
  route?: PushRoute | null
}

/** One line on what this step is and what happens next, in the owner's words. */
function bankLine(job: JobProgress | null, route: PushRoute | null | undefined, count: number | null): string {
  const cap = typeof route?.threshold === 'number' ? ` (shared ${fmt.format(route.threshold)}-contact cap)` : ''
  return `${count != null ? `${fmt.format(count)} leads` : 'Leads'} → lead bank · rotates into ${job?.instantly_campaign_name ?? 'the campaign'} as slots free${cap}.`
}

function explain(node: FlowNode, job: JobProgress | null, route?: PushRoute | null): string {
  const s = node.state
  switch (node.id) {
    case 'imported':
      return 'The CSV as it arrived.'
    case 'approved':
      if (s === 'needs_you')
        return node.gate?.actions.length === 1 ? 'No email column was found, so this list can only be denied.' : 'Approve to start validating. Approve + Enrich also looks up each valid lead’s city (spends credits).'
      return s === 'done' ? `Approved${job?.enrich ? ' with enrichment' : ''}.` : 'Waits for your approval.'
    case 'finder':
      return s === 'needs_you'
        ? `${fmt.format(job?.rows_missing_email ?? 0)} rows have no email. Find them first (spends credits) or validate only the rows that have one.`
        : 'The email finder ran before validation.'
    case 'validate':
      if (s === 'needs_you') return 'The validator stopped making progress. Resume picks up where it left off.'
      if (s === 'active') return 'Checking every email with MailTester.'
      if (s === 'failed') return 'Validation stopped with an error.'
      return s === 'done' ? 'Every row has a verdict.' : 'Starts once the steps before it are done.'
    case 'enrich':
      if (s === 'active') return 'Looking up a city for each valid lead.'
      return s === 'done' ? 'City lookup finished for the valid leads.' : 'Looks up a city for each valid lead once validation is done.'
    case 'campaign':
      if (s === 'needs_you') return 'Pick the Instantly campaign these leads go to. Nothing is pushed yet.'
      if (s === 'skipped') return 'The push was cancelled for this list.'
      return s === 'done' ? 'Where these leads go in Instantly.' : 'Offered once validation (and enrichment) finish.'
    case 'review':
      if (s === 'needs_you' && isBankRoute(route)) {
        const n = typeof route?.banked_estimate === 'number' ? `${fmt.format(route.banked_estimate)} leads` : 'These leads'
        return `${n} is over the ${fmt.format(route?.threshold ?? 1000)}-lead limit, so they go to the lead bank, not straight into Instantly. The rotation moves them into ${job?.instantly_campaign_name ?? 'the campaign'} as Instantly frees slots. Set the barriers and names, then confirm.`
      }
      if (s === 'needs_you') return 'Set the barriers and check the company names. Push these asks for one more confirmation — nothing moves before it.'
      if (s === 'skipped') return 'The push was cancelled for this list.'
      return s === 'todo' ? 'Barriers and company names, after the campaign is picked.' : 'Barriers and names were set for the push.'
    case 'push': {
      const banked = job ? bankedCount(job) : 0
      if (isBankRoute(route) && (s === 'needs_you' || s === 'todo'))
        return `${s === 'needs_you' ? 'Confirm to send. ' : ''}${bankLine(job, route, typeof route?.banked_estimate === 'number' ? route.banked_estimate : null)}`
      if (banked > 0 && (s === 'done' || s === 'active')) return bankLine(job, route, banked)
      if (s === 'needs_you') return 'Confirm to push. This is the last tap before leads land in Instantly.'
      if (s === 'active') return 'Pushing leads into Instantly.'
      if (s === 'failed') return 'The push stopped with an error — Telegram has the details.'
      if (s === 'skipped') return 'The push was cancelled for this list.'
      return s === 'done' ? 'Leads are in Instantly.' : 'Waits for the review step.'
    }
    case 'launch':
      if (s === 'needs_you') return 'Confirm to launch the campaign in Instantly.'
      if (s === 'done') return 'The campaign is sending.'
      if (s === 'skipped') return 'The push was cancelled for this list.'
      return job?.instantly_status === 'done' ? 'Pushed leads wait in the campaign until it is launched in Instantly.' : 'After the push.'
  }
}

/** The gate's choices inside the panel: a focusable group (J/K, A/R) carrying the gate key. */
function StepGate({ gate, focusedKey, busyKeys, countOpenKey, onAction, onCountOpenChange, onFocusGate, blockedFor, relabel, children }: StepGateProps & { gate: GateRow; relabel?: Readonly<Record<string, string>>; children?: ReactNode }) {
  const key = gateKey(gate)
  const titleId = useId()
  return (
    <div
      role="group"
      aria-label={`Your move: ${gate.title ?? gate.kind}${gate.subtitle ? ` — ${gate.subtitle}` : ''}`}
      tabIndex={key === focusedKey ? 0 : -1}
      data-gate={key}
      onFocus={() => onFocusGate(key)}
      className="flex flex-col gap-2 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-black"
    >
      <span id={titleId} className="sr-only">
        {gate.title}
      </span>
      {children}
      <GateActions
        gate={gate}
        busy={busyKeys.has(key)}
        countOpen={countOpenKey === key}
        onAction={(spec, count) => onAction(gate, spec, count)}
        onCountOpenChange={(open) => onCountOpenChange(key, open)}
        blocked={blockedFor(gate)}
        labelledBy={titleId}
        relabel={relabel}
      />
    </div>
  )
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  const shown = rows.filter(([, v]) => v !== null && v !== undefined && v !== '')
  if (!shown.length) return null
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-[12px]">
      {shown.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-fg-46">{k}</dt>
          <dd className="truncate text-fg tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

function ValidateDetails({ job }: { job: JobProgress }) {
  const reasons = useJobReasons(job.id, job.status)
  return <JobProgressView job={job} reasons={reasons.data?.reasons} />
}

function Details({ node, run, job }: { node: FlowNode; run: RunSummary; job: JobProgress | null }) {
  const created = new Date(job?.created_at ?? run.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
  switch (node.id) {
    case 'imported':
      return (
        <Facts
          rows={[
            ['File', job?.filename ?? run.filename],
            ['Rows', fmt.format(job?.total_rows ?? run.total_rows)],
            ['Source', job ? (job.source ? sourceLabel({ sender_name: null, source: job.source }) : null) : node.gate?.subtitle?.match(/from ([^·]+)/)?.[1]?.trim()],
            ['Received', created],
          ]}
        />
      )
    case 'approved':
      return job ? <Facts rows={[['Choice', job.enrich ? 'Approve + Enrich' : 'Approve (validate only)']]} /> : null
    case 'finder':
      return job ? (
        <Facts
          rows={[
            ['Without an email', fmt.format(job.rows_missing_email ?? 0)],
            ['Found', node.state === 'needs_you' ? null : fmt.format(job.emails_found ?? 0)],
          ]}
        />
      ) : null
    case 'validate':
      return job && node.state !== 'todo' ? <ValidateDetails job={job} /> : null
    case 'enrich': {
      if (!job || node.state === 'todo') return null
      const eta = job.eta_stage === 'enriching' ? liveEta(job, Date.now()) : null
      return (
        <div className="flex flex-col gap-3">
          <Bar value={job.enriched_rows} total={job.counts.valid} label={job.enrich_started ? 'Enriched (of valid)' : 'Enrich queued'} />
          <Facts rows={[['Without a city', node.state === 'done' ? fmt.format(Math.max(0, job.counts.valid - job.enriched_rows)) : null], ['ETA', eta]]} />
        </div>
      )
    }
    case 'campaign':
      return job && node.state === 'done' ? (
        <Facts
          rows={[
            ['Campaign', job.instantly_campaign_name],
            ['No-location campaign', job.instantly_campaign_name_nolocation],
          ]}
        />
      ) : null
    case 'review':
      return job && node.state !== 'todo' && node.state !== 'skipped' && !node.gate ? (
        <Facts
          rows={[
            ['Location barrier', job.location_barrier ? 'On' : 'Off'],
            ['Company barrier', job.company_barrier ? 'On' : 'Off'],
            ['Names', job.company_strict ? 'Stricter' : 'Standard'],
          ]}
        />
      ) : null
    case 'push':
      return job && (node.state === 'done' || node.state === 'active' || node.state === 'failed') ? (
        <Facts
          rows={[
            ['Lead bank', bankedCount(job) > 0 ? `${fmt.format(bankedCount(job))} banked` : null],
            ['Pushed', `${fmt.format(job.instantly_pushed ?? 0)} → ${job.instantly_campaign_name ?? 'campaign'}`],
            ['No-location', job.instantly_campaign_name_nolocation ? `${fmt.format(job.instantly_pushed_nolocation ?? 0)} → ${job.instantly_campaign_name_nolocation}` : null],
          ]}
        />
      ) : null
    case 'launch':
      return job?.instantly_campaign_name ? <Facts rows={[['Campaign', job.instantly_campaign_name]]} /> : null
  }
}

/** Nested panels (barriers, names, no-location) sit as quiet wells inside the one dark surface. */
const WELLS = '[&_[data-slot=card]]:border-transparent [&_[data-slot=card]]:bg-white/[0.045] [&_[data-slot=card]]:shadow-none [&_[data-slot=card]]:backdrop-blur-none'

/**
 * The selected step: heading and state, one line on what it means, the
 * gate's choices (the only place this run's buttons live), then the details.
 */
export function StepDetail(props: StepDetailProps) {
  const { node, index, count, run, job, pickerTick } = props
  const gate = node.gate
  const headingId = useId()
  const stateTone =
    node.state === 'needs_you' || node.state === 'active' ? 'text-lime' : node.state === 'failed' ? 'text-red' : node.state === 'done' ? 'text-fg-70' : 'text-fg-46'

  return (
    <section aria-label="Step detail" className={cn('flex min-w-0 flex-col gap-5', WELLS)} data-testid="step-detail">
      <header className="flex flex-col gap-1.5">
        <p className="flex items-center gap-2 text-[11px] text-fg-46">
          <span className="font-mono tabular-nums">
            Step {index} of {count}
          </span>
          <span aria-hidden>·</span>
          <span className={cn('font-semibold', stateTone)}>{STATE_WORD[node.state]}</span>
        </p>
        <h2 id={headingId} className="text-[20px] leading-tight font-semibold tracking-tight text-fg">
          {node.label}
        </h2>
        <p className="max-w-[68ch] text-[13px] leading-relaxed text-fg-70">{explain(node, job, props.route)}</p>
      </header>

      {gate && (
        <StepGate
          gate={gate}
          {...props}
          relabel={
            gate.kind === 'push_review' && isBankRoute(props.route)
              ? { push_to_instantly: `Send ${typeof props.route?.banked_estimate === 'number' ? `${fmt.format(props.route.banked_estimate)} ` : ''}to lead bank` }
              : undefined
          }
        >
          {gate.kind === 'lume_action' && gate.subtitle && <p className="text-[13px] text-fg">{gate.subtitle}</p>}
          {gate.kind === 'ingest_approval' && gate.subtitle && <p className="text-[12px] text-fg-46">{gate.subtitle}</p>}
        </StepGate>
      )}

      {gate?.kind === 'campaign_choice' && <BarrierPanel gate={gate} pickerFocusTick={pickerTick} />}
      {gate?.kind === 'push_review' && (
        <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-3 lg:grid-cols-2">
          <div className="flex flex-col gap-3">
            <BarrierPanel gate={gate} />
          </div>
          <CompanyReview jobId={gate.target_id} />
        </div>
      )}

      {node.id === 'push' && job && bankedCount(job) > 0 && <BankStanding jobId={job.id} campaign={job.instantly_campaign_name} />}
      <Details node={node} run={run} job={job} />
    </section>
  )
}

const when = (iso: string) => new Date(iso).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })

/**
 * A banked push in plain words: how many of its leads are in the lead bank vs
 * already in Instantly, how full Instantly is, what's queued ahead, and when
 * the next rotation runs.
 */
function BankStanding({ jobId, campaign }: { jobId: string; campaign: string | null }) {
  const { data } = useSWR<BankStatus>(`/api/jobs/${jobId}/bank`, fetchJson, { refreshInterval: 60_000 })
  if (!data) return null
  const full = data.in_instantly_total != null && data.in_instantly_total >= data.cap
  const rows: [string, string][] = [
    ['In the lead bank', `${fmt.format(data.queued)} waiting`],
    ['In Instantly', `${fmt.format(data.in_instantly)} from this list${data.done ? ` · ${fmt.format(data.done)} finished` : ''}`],
    ['Instantly now', data.in_instantly_total == null ? '—' : `${fmt.format(data.in_instantly_total)} / ${fmt.format(data.cap)} contacts${full ? ' — full' : ''}`],
    ['Queued ahead', data.ahead ? `${fmt.format(data.ahead)} leads from other lists go first` : 'nothing — next in line'],
    ['Next rotation', when(data.next_run_at)],
  ]
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-(--glass-fill) px-4 py-3.5">
      <p className="text-[13px] text-fg">
        {data.queued > 0 && data.in_instantly === 0
          ? full
            ? `Nothing from this list is in Instantly yet: Instantly is full, so ${campaign ?? 'the campaign'} gets leads as slots free${data.ahead ? `, after ${fmt.format(data.ahead)} older leads` : ''}.`
            : `Nothing from this list is in Instantly yet — the next rotation moves leads in.`
          : `${fmt.format(data.in_instantly)} in Instantly → ${fmt.format(data.queued)} still in the lead bank.`}
      </p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-[12px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-fg-46">{k}</dt>
            <dd className="text-fg tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
