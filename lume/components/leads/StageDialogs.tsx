'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { emptyFinalForm, finalFilterFromForm, type FinalForm } from '@/lib/leads/finalFilter'
import { stepLabel } from '@/lib/leads/steps'

/**
 * GTM-18 sheet moves on the Leads page:
 *  - Combine (step 2): pick other lead lists and a key, preview the overlay,
 *    save it as a new combined master. A filled cell is never overwritten
 *    unless one sheet is preferred.
 *  - Filter → Final (step 3): a saved filter turns this list into the final
 *    sheet; the preview shows how many rows stay and why the rest drop out.
 * Both only write Lume's own list rows; nothing is sent or spent.
 */

export interface StageList {
  id: string
  name: string
  item_count: number
}

const fmt = new Intl.NumberFormat('en-US')

/** Readable words for the stage routes' refusal codes. */
const STAGE_ERRORS: Record<string, string> = {
  too_many_rows: 'Those lists are too big to combine in one go (60,000 rows at most).',
  nothing_kept: 'That filter drops every row, so there is no final sheet to save.',
  list_not_found: 'One of those lists no longer exists.',
  influencer_sheet: 'Influencer candidate sheets can’t be combined or filtered.',
  duplicate_list: 'A list was picked twice.',
  prefer_not_in_lists: 'The preferred list has to be one of the lists being combined.',
  folder_not_found: 'That folder no longer exists.',
}

export function stageErrorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return STAGE_ERRORS[msg] ?? msg
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const json = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
  return json
}

interface CombineStats {
  input_rows: number
  output_rows: number
  merged: number
  no_key: number
  rows_with_conflicts: number
}

export function CombineDialog({
  open,
  list,
  others,
  projectId,
  onClose,
  onSaved,
}: {
  open: boolean
  /** The list the dialog was opened from; always part of the combine. */
  list: StageList
  /** The other lead lists that can join it. */
  others: StageList[]
  projectId: string | null
  onClose: () => void
  onSaved: (listId: string) => void
}) {
  const [picked, setPicked] = useState<string[]>([])
  const [key, setKey] = useState<'auto' | 'domain' | 'email'>('auto')
  const [rule, setRule] = useState<'fill_blanks' | 'prefer'>('fill_blanks')
  const [prefer, setPrefer] = useState(list.id)
  const [name, setName] = useState(`${list.name} (master)`)
  const [stats, setStats] = useState<CombineStats | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open) return
    setPicked([])
    setKey('auto')
    setRule('fill_blanks')
    setPrefer(list.id)
    setName(`${list.name} (master)`)
    setStats(null)
  }, [open, list.id, list.name])

  const ids = [list.id, ...picked]
  const chosen = [list, ...others.filter((o) => picked.includes(o.id))]
  const body = { list_ids: ids, key, rule, ...(rule === 'prefer' ? { prefer_list_id: prefer } : {}) }
  const ready = picked.length > 0 && (rule === 'fill_blanks' || ids.includes(prefer))
  const change = (fn: () => void) => {
    fn()
    setStats(null)
  }

  const run = async (save: boolean) => {
    setBusy(true)
    try {
      if (!save) {
        setStats((await post<{ stats: CombineStats }>('/api/lead-lists/combine', { ...body, preview: true })).stats)
        return
      }
      const out = await post<{ list: { id: string } }>('/api/lead-lists/combine', { ...body, name: name.trim(), project_id: projectId })
      toast.success(`Saved "${name.trim()}" as the combined master.`)
      onSaved(out.list.id)
      onClose()
    } catch (err) {
      toast.error(stageErrorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Combine into a master sheet</DialogTitle>
          <DialogDescription>
            Rows that share a key merge into one. By default a filled cell is never overwritten: a later sheet only fills blanks. Rows land at {stepLabel(2)}.
          </DialogDescription>
        </DialogHeader>

        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-[12px] text-fg-46">Lists to combine with {list.name}</legend>
          {others.length === 0 && <p className="text-[12.5px] text-fg-46">There is no other lead list yet.</p>}
          <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
            {others.map((o) => (
              <label key={o.id} className="flex items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  checked={picked.includes(o.id)}
                  disabled={!picked.includes(o.id) && picked.length >= 4}
                  onChange={(e) => change(() => setPicked((p) => (e.target.checked ? [...p, o.id] : p.filter((x) => x !== o.id))))}
                />
                <span className="min-w-0 flex-1 truncate">{o.name}</span>
                <span className="text-[11.5px] text-fg-46">{fmt.format(o.item_count)} rows</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-[12px] text-fg-46">
            Match rows on
            <SimpleSelect
              aria-label="Match rows on"
              value={key}
              onValueChange={(v) => change(() => setKey(v as typeof key))}
              options={[
                { value: 'auto', label: 'Domain, then email' },
                { value: 'domain', label: 'Domain only' },
                { value: 'email', label: 'Email only' },
              ]}
            />
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-fg-46">
            When cells disagree
            <SimpleSelect
              aria-label="When cells disagree"
              value={rule}
              onValueChange={(v) => change(() => setRule(v as typeof rule))}
              options={[
                { value: 'fill_blanks', label: 'Keep the first value' },
                { value: 'prefer', label: 'Prefer one list' },
              ]}
            />
          </label>
          {rule === 'prefer' && (
            <label className="flex flex-col gap-1 text-[12px] text-fg-46 sm:col-span-2">
              Preferred list
              <SimpleSelect aria-label="Preferred list" value={prefer} onValueChange={(v) => change(() => setPrefer(v))} options={chosen.map((c) => ({ value: c.id, label: c.name }))} />
            </label>
          )}
          <label className="flex flex-col gap-1 text-[12px] text-fg-46 sm:col-span-2">
            Master name
            <Input aria-label="Master name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
          </label>
        </div>

        {stats && (
          <p role="status" className="rounded-lg bg-white/4 px-3 py-2 text-[12.5px] text-fg-70">
            {fmt.format(stats.input_rows)} rows in, {fmt.format(stats.output_rows)} out: {fmt.format(stats.merged)} merged as duplicates
            {stats.no_key > 0 && `, ${fmt.format(stats.no_key)} with no domain or email kept as they are`}
            {stats.rows_with_conflicts > 0 && `, ${fmt.format(stats.rows_with_conflicts)} with cells that disagreed`}.
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" variant="outline" onClick={() => run(false)} disabled={busy || !ready}>
            Preview
          </Button>
          <Button type="button" onClick={() => run(true)} disabled={busy || !ready || !stats || !name.trim()}>
            Save master
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface FinalPreview {
  kept: number
  excluded: number
  reasons: { reason: string; count: number }[]
}

const REQUIRE: { key: FinalForm['require'][number]; label: string }[] = [
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'website', label: 'Website' },
  { key: 'linkedin', label: 'LinkedIn' },
]

export function FinalDialog({ open, list, onClose, onSaved }: { open: boolean; list: StageList; onClose: () => void; onSaved: (listId: string) => void }) {
  const [form, setForm] = useState<FinalForm>(emptyFinalForm)
  const [name, setName] = useState(`${list.name} (final)`)
  const [preview, setPreview] = useState<FinalPreview | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open) return
    setForm(emptyFinalForm())
    setName(`${list.name} (final)`)
    setPreview(null)
  }, [open, list.name])

  const filter = finalFilterFromForm(form)
  const set = <K extends keyof FinalForm>(k: K, v: FinalForm[K]) => {
    setForm((f) => ({ ...f, [k]: v }))
    setPreview(null)
  }
  const text = (k: 'exclude_categories' | 'exclude_keywords' | 'exclude_reason' | 'min_rating' | 'only_states' | 'only_cities', label: string, placeholder: string) => (
    <label className="flex flex-col gap-1 text-[12px] text-fg-46">
      {label}
      <Input aria-label={label} value={form[k]} placeholder={placeholder} maxLength={k === 'exclude_reason' ? 80 : 400} onChange={(e) => set(k, e.target.value)} />
    </label>
  )

  const run = async (save: boolean) => {
    if (!filter) return
    setBusy(true)
    try {
      if (!save) {
        setPreview(await post<FinalPreview>(`/api/lead-lists/${list.id}/final`, { filter, preview: true }))
        return
      }
      const out = await post<{ list: { id: string } }>(`/api/lead-lists/${list.id}/final`, { filter, name: name.trim() })
      toast.success(`Saved "${name.trim()}" as the final sheet.`)
      onSaved(out.list.id)
      onClose()
    } catch (err) {
      toast.error(stageErrorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Filter into the final sheet</DialogTitle>
          <DialogDescription>
            Rows the filter drops stay on the final sheet as excluded, with the reason. Every row lands at {stepLabel(3)}; this list&apos;s rows move forward to it too.
          </DialogDescription>
        </DialogHeader>

        <fieldset className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <legend className="mb-1 text-[12px] text-fg-46">Drop rows with no</legend>
          {REQUIRE.map((r) => (
            <label key={r.key} className="flex items-center gap-1.5 text-[13px]">
              <input
                type="checkbox"
                checked={form.require.includes(r.key)}
                onChange={(e) => set('require', e.target.checked ? [...form.require, r.key] : form.require.filter((x) => x !== r.key))}
              />
              {r.label}
            </label>
          ))}
        </fieldset>

        <div className="grid gap-2 sm:grid-cols-2">
          {text('exclude_categories', 'Drop these categories', 'Plumbing supply, Hardware store')}
          {text('exclude_keywords', 'Drop names with these words', 'supply, wholesale')}
          {text('exclude_reason', 'Reason for those', 'vendor')}
          {text('min_rating', 'Drop rated below', '4')}
          {text('only_states', 'Keep only these states', 'CA, NV')}
          {text('only_cities', 'Keep only these cities', 'Los Angeles, Pasadena')}
          <label className="flex items-center gap-2 text-[13px] sm:col-span-2">
            <input type="checkbox" checked={form.drop_duplicate_domains} onChange={(e) => set('drop_duplicate_domains', e.target.checked)} />
            Drop a later row whose domain is already on the sheet
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-fg-46 sm:col-span-2">
            Final sheet name
            <Input aria-label="Final sheet name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
          </label>
        </div>

        {preview && (
          <div role="status" className="rounded-lg bg-white/4 px-3 py-2 text-[12.5px] text-fg-70">
            <p>
              {fmt.format(preview.kept)} kept, {fmt.format(preview.excluded)} excluded.
            </p>
            {preview.reasons.length > 0 && (
              <ul className="mt-1 list-disc pl-4">
                {preview.reasons.slice(0, 6).map((r) => (
                  <li key={r.reason}>
                    {r.reason}: {fmt.format(r.count)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" variant="outline" onClick={() => run(false)} disabled={busy || !filter}>
            Preview
          </Button>
          <Button type="button" onClick={() => run(true)} disabled={busy || !filter || !preview || preview.kept === 0 || !name.trim()}>
            Save final sheet
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
