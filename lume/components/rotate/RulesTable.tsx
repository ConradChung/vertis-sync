'use client'

import Link from 'next/link'
import { Plus } from 'lucide-react'
import { ShimmerBar } from '@/components/overview/parts'
import { Button } from '@/components/ui/button'
import { formatRun } from '@/components/rotate/RuleSheet'
import { lastResultLabel } from '@/lib/rules/client'
import { parseRuleFilter, summarizeFilter } from '@/lib/rules/filter'
import { nextRun } from '@/lib/rules/nextRun'
import type { RuleView } from '@/lib/rules/view'
import { cn } from '@/lib/utils'

export interface RulesTableProps {
  rules: RuleView[] | undefined
  error?: unknown
  busyId: string | null
  onNew: () => void
  onEdit: (r: RuleView) => void
  onActivate: (r: RuleView) => void
  onPause: (r: RuleView) => void
  onDelete: (r: RuleView) => void
  onRetry?: () => void
}

const KIND_LABEL: Record<string, string> = {
  activate_rule: 'Activation awaiting confirmation',
  assign_leads: 'Assignment awaiting confirmation',
  delete_rule: 'Deletion awaiting confirmation',
}

/**
 * Rotation rules on pg_cron. Every 15 minutes the tick looks for due rules;
 * a due rule creates one assignment for you to confirm. "Activate" itself is a
 * confirmation; "Pause" takes effect at once.
 */
export function RulesTable(p: RulesTableProps) {
  const loading = p.rules === undefined && p.error == null
  return (
    <section className="surface min-w-0 overflow-hidden rounded-panel" aria-label="Rotation rules">
      <div className="flex items-center justify-between gap-3 px-[18px] py-3">
        <div>
          <h2 className="text-[13px] font-semibold text-fg">Rules</h2>
          <p className="text-[11px] text-fg-46">Checked every 15 min. A due rule asks before assigning anything.</p>
        </div>
        <Button size="sm" variant="outline" onClick={p.onNew}>
          <Plus aria-hidden /> New rule
        </Button>
      </div>
      {p.error != null && (
        <p className="flex items-center gap-3 border-t border-line px-[18px] py-2.5 text-[12px] text-amber" role="status">
          {p.rules ? "Couldn't refresh — showing the last data." : "Couldn't load rules."}
          {p.onRetry && (
            <button type="button" onClick={p.onRetry} className="text-violet-soft hover:text-fg">
              Retry
            </button>
          )}
        </p>
      )}
      {loading ? (
        <div className="flex flex-col gap-3 border-t border-line px-[18px] py-4" aria-busy="true">
          {[0, 1].map((i) => (
            <ShimmerBar key={i} className="h-5 w-full" />
          ))}
        </div>
      ) : (p.rules ?? []).length === 0 ? (
        <p className="border-t border-line px-[18px] py-8 text-center text-[13px] text-fg-46">No rules yet.</p>
      ) : (
        <div className="overflow-x-auto border-t border-line">
          <table className="w-full border-collapse text-[12px]">
            <thead className="text-left text-[11px] text-fg-46">
              <tr>
                <th className="px-[18px] py-2 font-medium">Rule</th>
                <th className="px-2 py-2 font-medium">Leads</th>
                <th className="px-2 py-2 font-medium">Schedule</th>
                <th className="px-2 py-2 font-medium">Status</th>
                <th className="px-2 py-2 font-medium">Last run</th>
                <th className="px-[18px] py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {p.rules!.map((r) => (
                <RuleRow key={r.id} r={r} {...p} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function RuleRow({ r, busyId, onEdit, onActivate, onPause, onDelete }: { r: RuleView } & RulesTableProps) {
  const busy = busyId === r.id
  const activation = r.awaiting.find((a) => a.kind === 'activate_rule')
  const last = lastResultLabel(r.last_result)
  const next = r.active ? (r.next_run_at ?? nextRun(r.cron)) : null
  return (
    <tr className="border-t border-line/60 align-top">
      <td className="px-[18px] py-2">
        <div className="font-medium text-fg">{r.name}</div>
        <div className="text-[11px] text-fg-46">→ {r.campaign_name ?? r.campaign_id}</div>
      </td>
      <td className="px-2 py-2 text-fg-70">
        {summarizeFilter(parseRuleFilter(r.filter))}
        <div className="text-[11px] text-fg-46">
          up to {r.daily_cap} · {r.order_by} first
        </div>
      </td>
      <td className="px-2 py-2">
        <div className="font-mono text-fg-70">{r.cron}</div>
        <div className="text-[11px] text-fg-46">{r.active ? `Next ${formatRun(next)}` : 'Not scheduled'}</div>
      </td>
      <td className="px-2 py-2">
        <span className={cn('text-[11px] font-medium', r.active ? 'text-green' : 'text-fg-46')}>{r.active ? 'Active' : 'Inactive'}</span>
        {r.awaiting.map((a) => (
          <Link key={a.id} href={`/actions/${a.id}`} className="block text-[11px] text-amber hover:text-fg">
            {KIND_LABEL[a.kind] ?? a.kind} →
          </Link>
        ))}
      </td>
      <td className={cn('max-w-[220px] px-2 py-2 text-[11px]', last.tone === 'warn' ? 'text-amber' : last.tone === 'ok' ? 'text-fg-70' : 'text-fg-46')}>
        {last.text}
      </td>
      <td className="px-[18px] py-2">
        <div className="flex justify-end gap-1">
          {r.active ? (
            <Button size="xs" variant="outline" disabled={busy} onClick={() => onPause(r)}>
              Pause
            </Button>
          ) : (
            <Button size="xs" disabled={busy || !!activation} onClick={() => onActivate(r)} title={activation ? 'Waiting for your confirmation' : undefined}>
              {activation ? 'Awaiting' : 'Activate…'}
            </Button>
          )}
          <Button size="xs" variant="ghost" disabled={busy || !!activation} onClick={() => onEdit(r)}>
            Edit
          </Button>
          {!r.active && (
            <Button size="xs" variant="ghost" disabled={busy || r.awaiting.length > 0} onClick={() => onDelete(r)} className="text-fg-46 hover:text-red">
              Delete
            </Button>
          )}
        </div>
      </td>
    </tr>
  )
}
