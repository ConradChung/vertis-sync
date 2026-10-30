import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { PageHead } from '@/components/shell/PageHead'
import { ActionPlan, type ActionView } from '@/components/actions/ActionPlan'
import { getAction } from '@/lib/actions/store'
import { requireOwner } from '@/lib/auth/guards'
import { uuidParam } from '@/lib/http/json'
import type { Json } from '@/lib/db/types'
import { diffSequences, type EditStep } from '@/lib/campaigns/sequence'
import { payloadLintSteps } from '@/lib/campaigns/sequenceAction'
import { sopGate } from '@/lib/copy/sopGate'
import { formatViolation } from '@/lib/copy/sopLint'

export const metadata: Metadata = { title: 'Confirm action' }
export const dynamic = 'force-dynamic'

const usd = (v: Json | undefined) => (typeof v === 'number' ? `$${v.toFixed(2)}` : '—')
const show = (v: Json) => {
  const s = Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ') : typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > 400 ? `${s.slice(0, 400)}…` : s
}

/** An Apify run: actor, cost, cap, then every input field the owner agreed to, then the run once started. */
function runActorDetails(payload: Record<string, Json>, result: Record<string, Json> | null): [string, string][] {
  const out: [string, string][] = [
    ['actor', `${payload.actor_title ?? ''} (${payload.actor_id ?? '—'})`],
    ['pricing', String(payload.pricing_model ?? '—').replaceAll('_', ' ').toLowerCase()],
    ['estimate', `${usd(payload.estimate_usd)}${payload.estimate_note ? ` — ${payload.estimate_note}` : ''}`],
    ['hard cap', `${usd(payload.budget_usd)} (limit ${usd(payload.cap_usd)} per run, enforced by Apify)`],
  ]
  const o = payload.options
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    const lim = [`timeout ${Math.round(Number(o.timeout) / 60)} min`]
    if (typeof o.maxItems === 'number') lim.push(`max ${o.maxItems.toLocaleString('en-US')} charged results`)
    if (typeof o.memory === 'number') lim.push(`${o.memory} MB memory`)
    out.push(['limits', lim.join(' · ')])
  }
  if (typeof payload.expected_items === 'number') out.push(['expected results', payload.expected_items.toLocaleString('en-US')])
  const input = payload.input
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const [k, v] of Object.entries(input)) out.push([`input · ${k}`, show(v)])
  }
  if (result && typeof result.run_id === 'string') {
    out.push(['run', `${result.run_id} (${result.status ?? '—'})`])
    if (typeof result.console_url === 'string') out.push(['console', result.console_url])
  }
  return out
}

/** A sequence edit: which campaign, how many steps, and the outcome once written. */
function sequenceDetails(payload: Record<string, Json>, result: Record<string, Json> | null): [string, string][] {
  const out: [string, string][] = [['campaign', `${payload.campaign_name ?? payload.campaign_id ?? '—'}`]]
  const before = Array.isArray(payload.before) ? payload.before.length : 0
  const after = Array.isArray(payload.after) ? payload.after.length : 0
  out.push(['steps', `${before} → ${after}`])
  out.push(['safety', 'Lume re-reads the live sequence before writing; if it changed in Instantly since this edit, nothing is written.'])
  if (result && typeof result.steps === 'number') out.push(['written', `${result.steps} steps saved to Instantly`])
  return out
}

/**
 * The SOP lint of a sequence edit against the SOP as it is now (the executor
 * runs the same check before writing): a details line, plus the blocking
 * violations while it still awaits a decision.
 */
function sequenceSop(payload: Record<string, Json>, awaiting: boolean): { line: [string, string]; violations?: string[] } {
  try {
    const id = typeof payload.campaign_id === 'string' ? payload.campaign_id : null
    const name = typeof payload.campaign_name === 'string' ? payload.campaign_name : null
    const gate = sopGate({ id, name }, payloadLintSteps(payload))
    const which = gate.client ? `${gate.client} client SOP` : 'base SOP'
    const warn = gate.warnings.length ? `; warnings: ${gate.warnings.map(formatViolation).join(' · ')}` : ''
    const line: [string, string] = ['sop check', gate.blocking.length ? `${gate.blocking.length} violation(s) of the ${which}${warn}` : `passes the ${which}${warn}`]
    return { line, ...(awaiting && gate.blocking.length ? { violations: gate.blocking.map(formatViolation) } : {}) }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { line: ['sop check', msg], ...(awaiting ? { violations: [msg] } : {}) }
  }
}

const asSteps = (v: Json | undefined): EditStep[] => (Array.isArray(v) ? (v as unknown as EditStep[]) : [])

/** Payload fields worth showing; the lead list and reply body are summarised. */
function details(payload: Record<string, Json>): [string, string][] {
  const out: [string, string][] = []
  for (const [k, v] of Object.entries(payload ?? {})) {
    if (k === 'summary') continue
    if ((k === 'leads' || k === 'lead_ids') && Array.isArray(v)) {
      out.push([k, `${v.length} rows`])
      continue
    }
    if (v === null || typeof v === 'object') continue
    const s = String(v)
    out.push([k, s.length > 400 ? `${s.slice(0, 400)}…` : s])
  }
  return out
}

/** The deep-link target of every pending-action prompt: `/actions/<id>`. */
export default async function ActionPage({ params }: { params: Promise<{ id: string }> }) {
  const auth = await requireOwner()
  if (!auth.ok) notFound()
  const id = uuidParam((await params).id)
  if (!id) notFound()
  const row = await getAction(id)
  if (!row) notFound()

  const sop = row.kind === 'update_sequence' && Array.isArray(row.payload?.steps) ? sequenceSop(row.payload ?? {}, row.status === 'awaiting') : null
  const view: ActionView = {
    id: row.id,
    kind: row.kind,
    summary: typeof row.payload?.summary === 'string' ? row.payload.summary : row.kind,
    details:
      row.kind === 'run_actor'
        ? runActorDetails(row.payload ?? {}, (row.result as Record<string, Json> | null) ?? null)
        : row.kind === 'update_sequence'
          ? [...sequenceDetails(row.payload ?? {}, (row.result as Record<string, Json> | null) ?? null), ...(sop ? [sop.line] : [])]
          : details(row.payload),
    ...(sop?.violations ? { sopViolations: sop.violations } : {}),
    ...(row.kind === 'update_sequence' ? { sequenceDiff: diffSequences(asSteps(row.payload?.before), asSteps(row.payload?.after)) } : {}),
    requestedBy: row.requested_by,
    status: row.status,
    decidedVia: row.decided_via,
    decidedAt: row.decided_at,
    executedAt: row.executed_at,
    createdAt: row.created_at,
    error: row.error,
  }

  return (
    <>
      <PageHead eyebrow="Pending action" title="Confirm action" sub="Nothing runs until you press Confirm — here or in Telegram." />
      <ActionPlan action={view} />
    </>
  )
}
