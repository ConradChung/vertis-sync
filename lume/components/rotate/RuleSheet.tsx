'use client'

import { useId, useState, type FormEvent } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DatePicker } from '@/components/ui/date-picker'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import type { CampaignView } from '@/hooks/useCampaigns'
import { createRule, errorText, updateRule, type RuleInput } from '@/lib/rules/client'
import { parseRuleFilter } from '@/lib/rules/filter'
import { isValidRuleCron, nextRun, RULE_MIN_INTERVAL_MINUTES } from '@/lib/rules/nextRun'
import type { RuleView } from '@/lib/rules/view'
import { OWNER_TZ } from '@/lib/time/owner'

const whenFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: OWNER_TZ,
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

export function formatRun(iso: string | null): string {
  return iso ? `${whenFmt.format(new Date(iso))} PT` : '—'
}

export interface RuleSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Editing this rule; `null` creates a new one. */
  rule: RuleView | null
  campaigns: CampaignView[]
  onSaved: () => void
}

function initial(rule: RuleView | null, campaigns: CampaignView[]): RuleInput {
  if (rule) {
    return {
      name: rule.name,
      campaign_id: rule.campaign_id,
      filter: parseRuleFilter(rule.filter),
      daily_cap: rule.daily_cap,
      order_by: rule.order_by,
      cron: rule.cron,
    }
  }
  const rot = campaigns.find((c) => c.rotator) ?? campaigns[0]
  return { name: '', campaign_id: rot?.external_id ?? '', filter: {}, daily_cap: 40, order_by: 'newest', cron: '0 8 * * 1-5' }
}

/**
 * Create / edit a rotation rule. Saving never activates it: a new rule is
 * inactive, and activation is a separate confirmation from the table.
 */
export function RuleSheet(p: RuleSheetProps) {
  return (
    <Sheet open={p.open} onOpenChange={p.onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto border-line bg-panel sm:max-w-md">
        {/* Remount per rule so the form starts from that rule's values. */}
        {p.open && <RuleForm key={p.rule?.id ?? 'new'} {...p} />}
      </SheetContent>
    </Sheet>
  )
}

function RuleForm({ rule, campaigns, onSaved, onOpenChange }: RuleSheetProps) {
  const [v, setV] = useState<RuleInput>(() => initial(rule, campaigns))
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null })
  const id = useId()
  const cronOk = isValidRuleCron(v.cron)
  const preview = cronOk ? nextRun(v.cron) : null
  const valid = v.name.trim() !== '' && v.campaign_id !== '' && cronOk && v.daily_cap >= 1 && v.daily_cap <= 1000
  const targets = campaigns.filter((c) => c.external_id)
  const field = 'h-8 text-[13px]'

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!valid || state.busy) return
    setState({ busy: true, error: null })
    const body = { ...v, name: v.name.trim(), cron: v.cron.trim() }
    const a = rule ? await updateRule(rule.id, body) : await createRule(body)
    if ((a.status === 200 || a.status === 201) && a.body?.ok) {
      onSaved()
      onOpenChange(false)
    } else setState({ busy: false, error: errorText(a) })
  }

  const setFilter = (k: keyof RuleInput['filter'], val: string) =>
    setV((s) => ({ ...s, filter: { ...s.filter, [k]: val || undefined } }))

  return (
    <form onSubmit={submit} className="flex min-h-full flex-col">
      <SheetHeader className="px-5 pt-5">
        <SheetTitle>{rule ? 'Edit rule' : 'New rotation rule'}</SheetTitle>
        <SheetDescription className="text-fg-46">
          On schedule, Lume counts matching leads and asks you to confirm an assignment. It never assigns or pushes on its own.
        </SheetDescription>
      </SheetHeader>
      <div className="flex flex-col gap-4 px-5">
        <label className="flex flex-col gap-1 text-[12px] text-fg-70" htmlFor={`${id}-name`}>
          Name
          <Input id={`${id}-name`} className={field} value={v.name} maxLength={80} onChange={(e) => setV({ ...v, name: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-fg-70" htmlFor={`${id}-camp`}>
          Campaign
          <SimpleSelect
            id={`${id}-camp`}
            value={v.campaign_id}
            onValueChange={(campaign_id) => setV({ ...v, campaign_id })}
            options={
              targets.length === 0
                ? [{ value: '', label: 'Sync campaigns first' }]
                : targets.map((c) => ({ value: c.external_id!, label: `${c.name}${c.rotator ? ' (rotator)' : ''}` }))
            }
          />
        </label>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-[12px] text-fg-70">Which leads</legend>
          <SimpleSelect
            aria-label="Source"
            value={v.filter.source ?? ''}
            onValueChange={(val) => setFilter('source', val)}
            options={[
              { value: '', label: 'Unassigned validated leads' },
              { value: 'lead_bank', label: 'Leads queued for another campaign' },
            ]}
          />
          <div className="grid grid-cols-2 gap-2">
            <Input aria-label="ICP status" placeholder="ICP status" className={field} value={v.filter.icp_status ?? ''} onChange={(e) => setFilter('icp_status', e.target.value)} />
            <Input aria-label="City contains" placeholder="City contains" className={field} value={v.filter.city ?? ''} onChange={(e) => setFilter('city', e.target.value)} />
          </div>
          <label className="flex items-center gap-2 text-[12px] text-fg-46" htmlFor={`${id}-since`}>
            Since
            <DatePicker id={`${id}-since`} className="flex-1" placeholder="Any date" value={v.filter.since ?? ''} onChange={(val) => setFilter('since', val)} />
          </label>
        </fieldset>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-[12px] text-fg-70" htmlFor={`${id}-cap`}>
            Leads per run
            <Input
              id={`${id}-cap`}
              type="number"
              min={1}
              max={1000}
              className={field}
              value={v.daily_cap}
              onChange={(e) => setV({ ...v, daily_cap: Number(e.target.value) })}
            />
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-fg-70" htmlFor={`${id}-order`}>
            Order
            <SimpleSelect
              id={`${id}-order`}
              value={v.order_by}
              onValueChange={(val) => setV({ ...v, order_by: val as RuleInput['order_by'] })}
              options={[
                { value: 'newest', label: 'Newest first' },
                { value: 'oldest', label: 'Oldest first' },
              ]}
            />
          </label>
        </div>
        <label className="flex flex-col gap-1 text-[12px] text-fg-70" htmlFor={`${id}-cron`}>
          Schedule (cron, {OWNER_TZ})
          <Input
            id={`${id}-cron`}
            className={`${field} font-mono`}
            value={v.cron}
            spellCheck={false}
            aria-invalid={!cronOk || undefined}
            aria-describedby={`${id}-cron-hint`}
            onChange={(e) => setV({ ...v, cron: e.target.value })}
          />
          <span id={`${id}-cron-hint`} className={cronOk ? 'text-[11px] text-fg-46' : 'text-[11px] text-amber'}>
            {cronOk ? `Next: ${formatRun(preview)}` : `Five fields, at most every ${RULE_MIN_INTERVAL_MINUTES} minutes (e.g. 0 8 * * 1-5).`}
          </span>
        </label>
        {rule?.active && <p className="text-[11px] text-fg-46">This rule is active; edits apply from its next run.</p>}
      </div>
      <SheetFooter className="px-5 pb-5">
        <p role="status" aria-live="polite" className="min-h-[16px] text-[12px] text-amber">
          {state.error}
        </p>
        <Button type="submit" disabled={!valid || state.busy} aria-busy={state.busy || undefined}>
          {state.busy && <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />}
          {rule ? 'Save rule' : 'Create rule (inactive)'}
        </Button>
      </SheetFooter>
    </form>
  )
}
