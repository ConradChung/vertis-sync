'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { toast } from 'sonner'
import { CampaignCards } from '@/components/rotate/CampaignCards'
import { bundleOf, LeadBank } from '@/components/rotate/LeadBank'
import { RuleSheet } from '@/components/rotate/RuleSheet'
import { RulesTable } from '@/components/rotate/RulesTable'
import { SequencePreview } from '@/components/rotate/SequencePreview'
import { useCampaigns, type CampaignView } from '@/hooks/useCampaigns'
import { useRotation } from '@/hooks/useRotation'
import { useRules } from '@/hooks/useRules'
import type { LeadBankFilter } from '@/lib/db/leadBankQuery'
import {
  deleteRule,
  dragLabel,
  errorText,
  refKey,
  requestActivate,
  requestAssign,
  updateRule,
  type DragLeads,
  type LeadRef,
} from '@/lib/rules/client'
import type { RuleView } from '@/lib/rules/view'

const PAGE_SIZE = 100

function confirmToast(text: string, actionId: string) {
  toast.success(text, {
    description: 'Waiting for your tap — here or in Telegram.',
    action: { label: 'Review', onClick: () => window.location.assign(`/actions/${actionId}`) },
  })
}

/**
 * `/rotate`: lead bank → campaign cards (drag to assign), sequence rail, and
 * rotation rules. Every write here is a request: a drop creates an
 * `assign_leads` pending action, "Activate" an `activate_rule` one; both ping
 * Telegram and wait for a tap. Pause, edit and delete of an inactive rule are
 * direct (they can only stop things).
 */
export function RotateScreen() {
  const [filter, setFilter] = useState<LeadBankFilter>({})
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Map<string, LeadRef>>(new Map())
  const [preview, setPreview] = useState<CampaignView | null>(null)
  const [dragging, setDragging] = useState<DragLeads | null>(null)
  const [busyCampaign, setBusyCampaign] = useState<string | null>(null)
  const [busyRule, setBusyRule] = useState<string | null>(null)
  const [sheet, setSheet] = useState<{ open: boolean; rule: RuleView | null }>({ open: false, rule: null })

  const bank = useRotation({ filter, page, pageSize: PAGE_SIZE })
  const camps = useCampaigns()
  const rules = useRules()
  const total = bank.data?.total ?? 0
  const bundle = useMemo(() => bundleOf(selected, filter, total), [selected, filter, total])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor))

  async function assign(c: CampaignView, d: DragLeads) {
    if (!c.external_id) return
    if (d.type === 'filter' && d.total === 0) return
    setBusyCampaign(c.id)
    const a = await requestAssign(c.external_id, d)
    setBusyCampaign(null)
    if (a.status === 201 && a.body?.ok) {
      confirmToast(`Assignment requested: ${a.body.action.summary}`, a.body.action.id)
      if (d.type === 'leads') setSelected(new Map())
    } else toast.error(errorText(a))
  }

  function onDragStart(e: DragStartEvent) {
    setDragging((e.active.data.current as DragLeads | undefined) ?? null)
  }

  function onDragEnd(e: DragEndEvent) {
    setDragging(null)
    const d = e.active.data.current as DragLeads | undefined
    const c = (e.over?.data.current as { campaign?: CampaignView } | undefined)?.campaign
    if (d && c) void assign(c, d)
  }

  const setFilterReset = (f: LeadBankFilter) => {
    setFilter(f)
    setPage(1)
  }

  async function ruleOp(r: RuleView, op: 'activate' | 'pause' | 'delete') {
    if (op === 'delete' && !window.confirm(`Delete rule "${r.name}"?`)) return
    setBusyRule(r.id)
    const a = op === 'activate' ? await requestActivate(r.id) : op === 'pause' ? await updateRule(r.id, { active: false }) : await deleteRule(r.id)
    setBusyRule(null)
    if (op === 'activate' && a.status === 201 && a.body && 'action' in a.body) {
      const action = (a.body as { action: { id: string; summary: string } }).action
      confirmToast(`Activation requested for "${r.name}"`, action.id)
    } else if (op !== 'activate' && a.status === 200) {
      toast.success(op === 'pause' ? `Paused "${r.name}"` : `Deleted "${r.name}"`)
    } else toast.error(errorText(a))
    void rules.mutate()
  }

  return (
    <DndContext id="rotate-dnd" sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
      <div className="flex flex-col gap-5">
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
          <LeadBank
            rows={bank.data?.rows}
            total={total}
            page={page}
            pageSize={PAGE_SIZE}
            error={bank.error}
            filter={filter}
            onFilterChange={setFilterReset}
            onPage={setPage}
            selected={selected}
            onToggle={(ref) =>
              setSelected((m) => {
                const n = new Map(m)
                if (n.has(refKey(ref))) n.delete(refKey(ref))
                else n.set(refKey(ref), ref)
                return n
              })
            }
            onTogglePage={(refs, on) =>
              setSelected((m) => {
                const n = new Map(m)
                for (const r of refs) {
                  if (on) n.set(refKey(r), r)
                  else n.delete(refKey(r))
                }
                return n
              })
            }
            onClearSelection={() => setSelected(new Map())}
            onRetry={() => void bank.mutate()}
          />
          <div className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-[96px]">
            <CampaignCards
              campaigns={camps.data}
              error={camps.error}
              selectedId={preview?.id ?? null}
              onSelect={setPreview}
              onAssignHere={(c) => void assign(c, bundle)}
              bundleLabel={dragLabel(bundle)}
              busyId={busyCampaign}
              onSynced={() => void camps.mutate()}
            />
            <SequencePreview campaign={preview} />
          </div>
        </div>
        <RulesTable
          rules={rules.data}
          error={rules.error}
          busyId={busyRule}
          onNew={() => setSheet({ open: true, rule: null })}
          onEdit={(r) => setSheet({ open: true, rule: r })}
          onActivate={(r) => void ruleOp(r, 'activate')}
          onPause={(r) => void ruleOp(r, 'pause')}
          onDelete={(r) => void ruleOp(r, 'delete')}
          onRetry={() => void rules.mutate()}
        />
        <p className="text-[11px] text-fg-46">
          Nothing here assigns or pushes on its own. Pending confirmations are listed in{' '}
          <Link href="/validate" className="text-violet-soft hover:text-fg">
            Validate
          </Link>{' '}
          and sent to Telegram.
        </p>
      </div>
      <RuleSheet
        open={sheet.open}
        onOpenChange={(open) => setSheet((s) => ({ ...s, open }))}
        rule={sheet.rule}
        campaigns={camps.data ?? []}
        onSaved={() => void rules.mutate()}
      />
      <DragOverlay dropAnimation={null}>
        {dragging ? (
          <div className="glass rounded-[10px] px-3 py-1.5 text-[12px] font-medium text-fg">Assign {dragLabel(dragging)}</div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}
