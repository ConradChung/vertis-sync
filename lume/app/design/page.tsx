'use client'

import dynamic from 'next/dynamic'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { GlassCard } from '@/components/ui/glass-card'
import { PageHead } from '@/components/shell/PageHead'
import { StatusBadge } from '@/components/import/StatusBadge'
import { OrdersTable } from '@/components/import/OrdersTable'
import { OverviewView } from '@/components/overview/OverviewView'
import { GateCard } from '@/components/validate/GateCard'
import { ValidateSkeleton, ValidateView } from '@/components/validate/ValidateView'
import { ActionPlan, type ActionView } from '@/components/actions/ActionPlan'
import { PlanCard } from '@/components/orb/PlanCard'
import { ToolLog } from '@/components/orb/ToolLog'
import type { OrbState } from '@/components/orb/Orb'
import type { EventRow, GateRow, OrderRow } from '@/lib/db/types'
import type { OverviewInstantly, OverviewPayload } from '@/lib/overview/types'

/**
 * `/design` — every Lume component in its idle / loading / empty / error /
 * pending-approval states, rendered from fixtures (no fetches, no writes;
 * buttons are wired to no-ops), plus the color tokens and type scale.
 * Owner-gated by the middleware like every other page.
 */

const Orb = dynamic(() => import('@/components/orb/Orb'), { ssr: false })

const noop = () => {}

const iso = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString()
const ID = '7db3d841-252c-4572-95ec-bc110727df8d'

const TOKENS = ['black', 'white', 'violet', 'lime', 'destructive', 'line', 'surface', 'fg-70', 'fg-46', 'fg-24']
const TYPE_SCALE: [string, string][] = [
  ['text-2xl font-semibold tracking-tight', 'Page title · 2xl semibold'],
  ['text-sm font-medium', 'Card title · sm medium'],
  ['text-[11px] uppercase tracking-[0.12em] text-muted-foreground', 'Eyebrow · 11 uppercase'],
  ['text-sm', 'Body · sm'],
  ['text-sm text-muted-foreground', 'Muted · sm / 55%'],
  ['font-mono text-sm tabular-nums', 'Mono · Geist Mono 1,234'],
]

const ev = (id: number, type: string, title: string, o: Partial<EventRow> = {}): EventRow => ({
  id,
  type,
  source: 'instantly',
  source_id: null,
  campaign_id: null,
  lead_email: 'ada@example.com',
  title,
  payload: {},
  webhook_id: null,
  created_at: iso(id * 7),
  ...o,
})

const overview = (full: boolean): OverviewPayload => ({
  now: iso(0),
  pending_gates: full ? 3 : 0,
  replies_today: full ? 4 : 0,
  bounces_24h: full ? 1 : 0,
  active_jobs: full ? 2 : 0,
  lead_bank_queued: full ? 812 : 0,
  events_last_at: full ? iso(3) : null,
  recent_events: [],
  scheduled_jobs: full
    ? [{ name: 'pipeline-watchdog', cron: '*/15 * * * *', runner: 'pg_cron', active: true, target: null, last_status: 'succeeded', last_run_at: iso(9), next_run: iso(-6) }]
    : [],
  next_runs: [],
  days: Array.from({ length: 7 }, (_, i) => iso((6 - i) * 1440).slice(0, 10)),
  replies_7d: full ? [1, 3, 2, 5, 0, 2, 4] : [0, 0, 0, 0, 0, 0, 0],
  gates_opened_7d: full ? [2, 1, 4, 0, 3, 2, 3] : [0, 0, 0, 0, 0, 0, 0],
  reply_feed: full ? [ev(1, 'interested', 'Ada Lovelace marked interested'), ev(2, 'reply', 'Reply from grace@example.com'), ev(3, 'bounce', 'Bounce: old@example.com')] : [],
  agent_activity: full ? [ev(4, 'lume.import', 'CSV upload · 240 rows', { source: 'lume', lead_email: null })] : [],
})
const NOT_CONNECTED: OverviewInstantly = { configured: false, campaigns: [] }

const ORDERS: OrderRow[] = [
  { kind: 'ingest', id: ID, source: 'lume', summary: 'leads.csv', row_count: 240, status: 'awaiting_approval', cost_usd: null, created_by: 'Lume', validation_job_id: null, created_at: iso(4) },
  { kind: 'apollo_order', id: '2b1e6f0e-6c1d-4f43-9a6e-1f6f0c9f4a11', source: 'apollo', summary: 'CEOs, Austin', row_count: 500, status: 'completed', cost_usd: 500, created_by: 'Telegram', validation_job_id: null, created_at: iso(300) },
]

const gate = (kind: GateRow['kind'], o: Partial<GateRow> = {}): GateRow => ({
  kind,
  target_table: 'validation_jobs',
  target_id: ID,
  title: 'leads.csv · 240 rows',
  subtitle: 'Email column: email',
  actions: [],
  counts: { rows: 240 },
  telegram_message_id: null,
  created_at: iso(12),
  ...o,
})

const action = (status: string, o: Partial<ActionView> = {}): ActionView => ({
  id: ID,
  kind: 'pause_campaign',
  summary: 'Pause campaign "Austin CEOs" (bounce rate 6.1% > 5%)',
  details: [
    ['Campaign', 'Austin CEOs'],
    ['Rule', 'bounce_rate > 5%'],
  ],
  requestedBy: 'rule',
  status,
  decidedVia: status === 'awaiting' ? null : 'telegram',
  decidedAt: status === 'awaiting' ? null : iso(2),
  executedAt: status === 'executed' ? iso(1) : null,
  createdAt: iso(20),
  error: status === 'failed' ? 'Instantly API: HTTP 502' : null,
  ...o,
})

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[18px] font-semibold text-fg">{title}</h2>
      {children}
    </section>
  )
}

function State({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className="font-mono text-[11px] tracking-wide text-fg-46 uppercase">{label}</span>
      {children}
    </div>
  )
}

export default function DesignPage() {
  const orbStates: OrbState[] = ['idle', 'listening', 'thinking', 'acting', 'needs-approval']
  return (
    <main className="shell flex flex-col gap-10 py-8">
      <PageHead eyebrow="Lume" title="Design" sub="Every component in every state, from fixtures. Nothing here fetches or writes." />

      <Section title="Tokens">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          {TOKENS.map((t) => (
            <div key={t} className="flex flex-col gap-1.5">
              <div className="h-12 rounded-control border border-line" style={{ background: `var(--${t})` }} />
              <span className="font-mono text-[11px] text-fg-70">--{t}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Type scale">
        <GlassCard className="gap-2 p-[18px]">
          {TYPE_SCALE.map(([cls, label]) => (
            <p key={label} className={cls}>
              {label}
            </p>
          ))}
        </GlassCard>
      </Section>

      <Section title="Buttons & badges">
        <div className="flex flex-wrap items-center gap-2">
          <Button>Primary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="link">Link</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="destructive">Destructive</Button>
          <Button variant="ghost">Ghost</Button>
          <Button disabled>Disabled</Button>
        </div>
        <div className="flex flex-wrap gap-2">
          {['awaiting_approval', 'running', 'completed', 'failed', 'denied', null].map((s) => (
            <StatusBadge key={String(s)} status={s} />
          ))}
        </div>
      </Section>

      <Section title="Overview">
        <State label="loading">
          <OverviewView data={undefined} />
        </State>
        <State label="error">
          <OverviewView data={undefined} error={new Error('fixture')} onRetry={noop} />
        </State>
        <State label="empty · Instantly not connected">
          <OverviewView data={overview(false)} instantly={NOT_CONNECTED} />
        </State>
        <State label="idle · data, stale refresh">
          <OverviewView data={overview(true)} error={new Error('fixture')} onRetry={noop} instantly={NOT_CONNECTED} />
        </State>
      </Section>

      <Section title="Orders">
        <div className="grid gap-4 lg:grid-cols-2">
          <State label="loading">
            <OrdersTable orders={undefined} selected={null} onSelect={noop} />
          </State>
          <State label="error">
            <OrdersTable orders={undefined} error={new Error('fixture')} selected={null} onSelect={noop} onRetry={noop} />
          </State>
          <State label="empty">
            <OrdersTable orders={[]} selected={null} onSelect={noop} />
          </State>
          <State label="idle · pending approval row selected">
            <OrdersTable orders={ORDERS} selected={{ kind: 'ingest', id: ID }} onSelect={noop} />
          </State>
        </div>
      </Section>

      <Section title="Validate gates">
        <div className="grid gap-4 lg:grid-cols-3">
          <State label="pending approval">
            <GateCard gate={gate('ingest_approval')} focused busy={false} onAction={noop} />
          </State>
          <State label="loading (decision in flight)">
            <GateCard gate={gate('ingest_approval')} focused={false} busy onAction={noop} />
          </State>
          <State label="blocked (no email column)">
            <GateCard gate={gate('ingest_approval', { actions: ['deny'], subtitle: 'No email column found' })} focused={false} busy={false} onAction={noop} />
          </State>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <State label="queue · loading">
            <ValidateSkeleton />
          </State>
          <State label="queue · empty">
            <ValidateView gates={[]} onRefresh={noop} />
          </State>
          <State label="queue · error">
            <ValidateView gates={undefined} error={new Error('fixture')} onRefresh={noop} />
          </State>
        </div>
      </Section>

      <Section title="Pending actions">
        <div className="grid gap-4 lg:grid-cols-3">
          <State label="pending approval">
            <ActionPlan action={action('awaiting')} />
          </State>
          <State label="already handled">
            <ActionPlan action={action('executed')} />
          </State>
          <State label="error">
            <ActionPlan action={action('failed')} />
          </State>
        </div>
      </Section>

      <Section title="Orb agent">
        <div className="flex flex-wrap gap-6">
          {orbStates.map((s) => (
            <State key={s} label={s}>
              <Orb state={s} compact />
            </State>
          ))}
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <State label="tool log · running / ok / awaiting / error">
            <ToolLog
              entries={[
                { id: '1', name: 'list_orders', tier: 'read', status: 'ok', ms: 212 },
                { id: '2', name: 'get_campaign', tier: 'read', status: 'running' },
                { id: '3', name: 'send_reply', tier: 'high', status: 'awaiting', ms: 40 },
                { id: '4', name: 'list_gates', tier: 'read', status: 'error', ms: 1200, error: 'HTTP 500' },
              ]}
            />
          </State>
          <State label="plan card · pending approval">
            <PlanCard approvals={[{ action_id: ID, deep_link: `/actions/${ID}`, summary: 'Reply to ada@example.com', tool: 'send_reply' }]} />
          </State>
          <State label="tool log · empty">
            <ToolLog entries={[]} />
          </State>
        </div>
      </Section>
    </main>
  )
}
