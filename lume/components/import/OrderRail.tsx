'use client'

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { ExternalLink, Loader2, X } from 'lucide-react'
import { ShimmerBar, SectionTitle } from '@/components/overview/parts'
import { StatusBadge } from '@/components/import/StatusBadge'
import { Button, buttonVariants } from '@/components/ui/button'
import { GlassCard } from '@/components/ui/glass-card'
import { Input } from '@/components/ui/input'
import { isValidCount } from '@/components/validate/GateCard'
import { useOrderDetail } from '@/hooks/useOrders'
import type { OrderKind } from '@/lib/db/types'
import type { CsvSample } from '@/lib/import/csv'
import { KIND_LABEL, sourceLabel } from '@/lib/import/format'
import { LFO_COUNT_OPTIONS } from '@/lib/import/messages'
import type { EnrichmentConfig, OrderDetail } from '@/lib/import/orderDetail'
import { clientOutcome } from '@/lib/validate/decideResult'
import { sendJson } from '@/lib/validate/client'
import { cn } from '@/lib/utils'

const fmt = new Intl.NumberFormat('en-US')

export interface OrderRailProps {
  selected: { kind: OrderKind; id: string } | null
  onClose?: () => void
  /** A decision went out: refresh the table. */
  onChanged?: () => void
}

/** Right rail for the selected order: facts, sample, enrichment config, gate link, count picker. */
export function OrderRail({ selected, onClose, onChanged }: OrderRailProps) {
  const q = useOrderDetail(selected)
  if (!selected) {
    return (
      <GlassCard className="items-center gap-1 py-10 text-center" aria-label="Order detail">
        <p className="text-[13px] text-fg-70">Select an order</p>
        <p className="text-[11px] text-fg-46">Its sample rows, enrichment settings and open gate show here.</p>
      </GlassCard>
    )
  }
  return (
    <OrderRailView
      kind={selected.kind}
      detail={q.data}
      error={q.error}
      onRetry={() => void q.mutate()}
      onClose={onClose}
      onDecided={() => {
        void q.mutate()
        onChanged?.()
      }}
    />
  )
}

export interface OrderRailViewProps {
  kind: OrderKind
  detail: OrderDetail | undefined
  error?: unknown
  onRetry?: () => void
  onClose?: () => void
  onDecided?: () => void
}

export function OrderRailView({ kind, detail, error, onRetry, onClose, onDecided }: OrderRailViewProps) {
  return (
    <GlassCard className="gap-0 py-0" role="region" aria-label="Order detail">
      <SectionTitle title={KIND_LABEL[kind]}>
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Close order panel" className="rounded p-0.5 text-fg-46 hover:text-fg">
            <X className="size-3.5" aria-hidden />
          </button>
        )}
      </SectionTitle>
      <div className="flex flex-col gap-4 px-[18px] pb-[18px] text-[12px] text-fg-70">
        {error != null && !detail ? (
          <p className="flex items-center gap-3 text-amber" role="status">
            Couldn&apos;t load this order.
            {onRetry && (
              <button type="button" onClick={onRetry} className="text-violet-soft hover:text-fg">
                Retry
              </button>
            )}
          </p>
        ) : !detail ? (
          <div className="flex flex-col gap-2.5" aria-busy="true" aria-label="Loading order">
            <ShimmerBar className="h-3 w-1/2" />
            <ShimmerBar className="h-3 w-full" />
            <ShimmerBar className="h-16 w-full" />
          </div>
        ) : (
          <DetailBody detail={detail} onDecided={onDecided} />
        )}
      </div>
    </GlassCard>
  )
}

function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[11px]">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-fg-46">{k}</dt>
          <dd className="truncate text-right text-fg">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

const num = (n: number | null | undefined) => (n == null ? '—' : fmt.format(n))
const mono = (v: ReactNode) => <span className="font-mono tabular-nums">{v}</span>

function GateLink({ detail }: { detail: OrderDetail }) {
  if (!detail.gate) return null
  return (
    <Link
      href={`/validate?gate=${encodeURIComponent(detail.gate.param)}`}
      className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'self-start')}
    >
      Open in Validate →
    </Link>
  )
}

function DetailBody({ detail, onDecided }: { detail: OrderDetail; onDecided?: () => void }) {
  switch (detail.kind) {
    case 'ingest':
      return (
        <>
          <Facts
            items={[
              ['Status', <StatusBadge key="s" status={detail.status} />],
              ['File', <span key="f" title={detail.filename}>{detail.filename}</span>],
              ['From', sourceLabel(detail.source)],
              ['Rows', mono(num(detail.row_count))],
              ['Email column', detail.email_column ? mono(detail.email_column) : <span key="e" className="text-amber">not detected</span>],
            ]}
          />
          <GateLink detail={detail} />
          <SampleTable sample={detail.sample} caption={detail.sample_from === 'job' ? 'First rows in the job' : 'First rows of the file'} />
          {detail.enrichment ? <Enrichment cfg={detail.enrichment} /> : <p className="text-[11px] text-fg-46">Enrichment is chosen at approval (Approve or Approve + Enrich).</p>}
        </>
      )
    case 'dashboard_job':
      return (
        <>
          <Facts
            items={[
              ['Status', <StatusBadge key="s" status={detail.status} />],
              ['File', detail.filename ?? '—'],
              ['Rows', mono(num(detail.row_count))],
            ]}
          />
          <GateLink detail={detail} />
          <SampleTable sample={detail.sample} caption="First rows in the job" />
          {detail.enrichment && <Enrichment cfg={detail.enrichment} />}
        </>
      )
    case 'apollo_order':
      return (
        <>
          <Facts
            items={[
              ['Status', <StatusBadge key="s" status={detail.status} />],
              ['Contacts', mono(num(detail.contact_count))],
              ['Credits', mono(num(detail.credits_deducted))],
              ['Balance after', mono(num(detail.new_balance))],
              ['Leadsfriday order', detail.leadsfriday_order_id ? mono(`#${detail.leadsfriday_order_id}`) : '—'],
              ['Leadsfriday status', detail.leadsfriday_status ?? '—'],
            ]}
          />
          {detail.apollo_url && (
            <a href={detail.apollo_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 self-start text-violet-soft hover:text-fg">
              Apollo search <ExternalLink className="size-3" aria-hidden />
            </a>
          )}
          {detail.error && <p className="text-amber">{detail.error}</p>}
          {detail.awaiting_count && <CountPicker orderId={detail.id} onDecided={onDecided} />}
          {!detail.awaiting_count && <GateLink detail={detail} />}
        </>
      )
    case 'job_batch':
      return (
        <>
          <Facts
            items={[
              ['Status', <StatusBadge key="s" status={detail.status} />],
              ['Batch', mono(detail.batch_date)],
              ['Companies added', mono(num(detail.counts.companies_added))],
              ['Companies pulled', mono(num(detail.counts.companies_pulled))],
              ['Unresolved', mono(num(detail.counts.companies_unresolved))],
              ['Contacts', mono(num(detail.counts.contacts_total))],
              ['Kept', mono(num(detail.counts.contacts_kept))],
              ['Leadsfriday order', detail.leadsfriday_order_id ? mono(`#${detail.leadsfriday_order_id}`) : '—'],
            ]}
          />
          {detail.error && <p className="text-amber">{detail.error}</p>}
          <GateLink detail={detail} />
        </>
      )
  }
}

function SampleTable({ sample, caption }: { sample: CsvSample | null; caption: string }) {
  if (!sample || !sample.headers.length) return <p className="text-[11px] text-fg-46">No sample available.</p>
  return (
    <figure className="flex min-w-0 flex-col gap-1.5">
      <figcaption className="text-[11px] text-fg-46">{caption}</figcaption>
      <div className="max-w-full overflow-x-auto rounded-[10px] border border-line">
        <table className="border-collapse text-[11px]">
          <thead className="bg-white/[.03] text-left text-fg-46">
            <tr>
              {sample.headers.map((h, i) => (
                <th key={i} scope="col" className="border-b border-line px-2 py-1.5 font-medium whitespace-nowrap">
                  {h || <span className="text-fg-24">—</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sample.rows.map((r, ri) => (
              <tr key={ri} className="border-b border-line/50 last:border-0">
                {sample.headers.map((_, ci) => (
                  <td key={ci} className="max-w-[180px] truncate px-2 py-1.5 whitespace-nowrap text-fg-70" title={r[ci]}>
                    {r[ci] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  )
}

function Enrichment({ cfg }: { cfg: EnrichmentConfig }) {
  return (
    <section aria-label="Enrichment config" className="flex flex-col gap-1.5">
      <h3 className="text-[11px] text-fg-46">Enrichment (read-only)</h3>
      <Facts
        items={[
          ['Enrich', cfg.enrich ? 'On' : 'Off'],
          ['ICP filter', cfg.icp_filter ? 'On' : 'Off'],
        ]}
      />
      {cfg.icp_description && <p className="rounded-[10px] border border-line px-2.5 py-2 text-[11px] text-fg-70">{cfg.icp_description}</p>}
    </section>
  )
}

/**
 * Leadsfriday count for an Apollo order awaiting one. Choose a preset or type
 * a number (500–50 000), then click Order — `lfo_count:<id>:<n>` through
 * `/api/gates/decide`. Spends credits: a click only, never a key.
 */
export function CountPicker({ orderId, onDecided }: { orderId: string; onDecided?: () => void }) {
  const [choice, setChoice] = useState<number | null>(null)
  const [custom, setCustom] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const count = custom.trim() ? (isValidCount(custom) ? Number(custom) : null) : choice

  async function decide(callbackData: string, okText: string) {
    setBusy(true)
    setMsg(null)
    const a = await sendJson('/api/gates/decide', { callback_data: callbackData }, { timeoutMs: 180_000 })
    setBusy(false)
    const out = clientOutcome(a.status, a.body)
    if (out === 'done' || out === 'sent' || out === 'pending') {
      setMsg({ tone: 'ok', text: okText })
      onDecided?.()
    } else if (out === 'already_handled') {
      setMsg({ tone: 'bad', text: 'Already handled (from Telegram?) — refreshed.' })
      onDecided?.()
    } else {
      setMsg({ tone: 'bad', text: 'Could not send — try again.' })
    }
  }

  return (
    <section aria-label="Leadsfriday count" className="flex flex-col gap-2.5 rounded-[12px] border border-amber/30 bg-amber/[.06] p-3">
      <p className="text-[12px] text-fg">
        Waiting on a count. Credits are deducted when the order is placed.
      </p>
      <div role="radiogroup" aria-label="Contacts to export" className="flex flex-wrap gap-1.5">
        {LFO_COUNT_OPTIONS.map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={!custom.trim() && choice === n}
            disabled={busy}
            onClick={() => {
              setCustom('')
              setChoice(n)
            }}
            className="rounded-[8px] border border-line px-2.5 py-1 font-mono text-[12px] tabular-nums text-fg-70 transition-colors hover:text-fg aria-checked:border-violet aria-checked:bg-violet/15 aria-checked:text-fg"
          >
            {fmt.format(n)}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-2 text-[11px] text-fg-46">
        Custom
        <Input
          value={custom}
          onChange={(e) => setCustom(e.target.value.replace(/[^\d]/g, ''))}
          inputMode="numeric"
          placeholder="500–50000"
          aria-label="Custom count"
          aria-invalid={(custom.trim() !== '' && !isValidCount(custom)) || undefined}
          className="h-7 w-28 font-mono text-[12px]"
          disabled={busy}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={count === null || busy}
          onClick={() => count !== null && void decide(`lfo_count:${orderId}:${count}`, `Ordering ${fmt.format(count)} contacts…`)}
        >
          {busy && <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />}
          {count === null ? 'Order' : `Order ${fmt.format(count)}`}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void decide(`lfo_cancel:${orderId}`, 'Cancelled — no order placed.')}>
          Cancel order
        </Button>
      </div>
      <p role="status" aria-live="polite" className={msg?.tone === 'bad' ? 'text-[11px] text-amber' : 'text-[11px] text-green'}>
        {msg?.text}
      </p>
    </section>
  )
}
