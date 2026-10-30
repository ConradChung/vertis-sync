'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Clock3, Eye, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { ActionNotice, type NoticeState } from '@/components/campaigns/ActionNotice'
import { NotConnected, ShimmerBar } from '@/components/overview/parts'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { requestSequenceUpdate, useSequenceEdit } from '@/hooks/useSequenceEditor'
import {
  diffSequences,
  diffSummary,
  MAX_STEPS,
  MAX_VARIANTS,
  previewVariables,
  sequenceProblems,
  variablesIn,
  variantLetter,
  type DelayUnit,
  type EditStep,
  type EditVariant,
} from '@/lib/campaigns/sequence'
import { cn } from '@/lib/utils'

const UNITS = [
  { value: 'days', label: 'days' },
  { value: 'hours', label: 'hours' },
  { value: 'minutes', label: 'minutes' },
] as const

const SAVE_ERRORS: Record<string, string> = {
  sequence_changed: 'The sequence changed in Instantly since you opened it. Reload to get the latest, then edit again.',
  no_changes: 'Nothing changed yet.',
  instantly_unreachable: 'Instantly could not be reached. Try again in a moment.',
  network: 'Network error. Try again.',
}

/**
 * Campaigns → Sequence: the campaign's emails, editable. "Request change"
 * files an `update_sequence` approval (before/after diff on /actions/<id>,
 * Telegram backup); Instantly is only written after the owner confirms.
 */
export function SequenceEditor({ campaignId }: { campaignId: string }) {
  const { data, error, mutate, isValidating } = useSequenceEdit(campaignId)
  const [draft, setDraft] = useState<EditStep[] | null>(null)
  const [preview, setPreview] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<NoticeState | null>(null)
  const [problems, setProblems] = useState<string[]>([])
  /** Set when the server's SOP lint refused the edit (each problem names rule, step and variant). */
  const [sopBlocked, setSopBlocked] = useState(false)
  /** SOP lint warnings on an edit that was filed anyway (never blocking). */
  const [sopWarnings, setSopWarnings] = useState<string[]>([])

  const loaded = data?.configured ? data.steps : null
  const steps = useMemo(() => draft ?? loaded ?? [], [draft, loaded])
  const diff = useMemo(() => (loaded && draft ? diffSequences(loaded, draft) : []), [loaded, draft])
  const live = useMemo(() => sequenceProblems(steps), [steps])

  if (error && !data) return <p className="py-6 text-[13px] text-fg-46" role="alert">Couldn&apos;t load the sequence from Instantly.</p>
  if (!data) return <ShimmerBar className="h-[240px] w-full" />
  if (!data.configured) return <NotConnected>Instantly not connected — the sequence can&apos;t be loaded</NotConnected>

  const update = (fn: (s: EditStep[]) => EditStep[]) => {
    setDraft(fn(structuredClone(steps)))
    setNotice(null)
    setProblems([])
    setSopBlocked(false)
    setSopWarnings([])
  }
  const setVariant = (i: number, j: number, patch: Partial<EditVariant>) =>
    update((s) => {
      s[i].variants[j] = { ...s[i].variants[j], ...patch }
      return s
    })

  const save = async () => {
    if (!draft) return
    if (live.length) return setProblems(live)
    setBusy(true)
    const r = await requestSequenceUpdate(campaignId, draft, data.hash)
    setBusy(false)
    if (r.ok) {
      setNotice({ kind: 'created', id: r.id, summary: r.summary })
      setSopWarnings(r.warnings ?? [])
      void mutate()
    } else if (r.error === 'duplicate') setNotice({ kind: 'duplicate', existingId: r.existingId ?? null })
    else if (r.problems?.length) {
      setProblems(r.problems)
      setSopBlocked(r.error === 'sop_violations' || r.error === 'sop_invalid')
    } else setNotice({ kind: 'error', message: SAVE_ERRORS[r.error] ?? r.error })
  }

  const reload = async () => {
    setDraft(null)
    setNotice(null)
    setProblems([])
    setSopBlocked(false)
    setSopWarnings([])
    await mutate()
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] text-fg-46">
          {steps.length} step{steps.length === 1 ? '' : 's'} · edits are sent for approval, then saved to Instantly.
        </p>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setPreview((p) => !p)} aria-pressed={preview}>
            {preview ? <Pencil /> : <Eye />} {preview ? 'Edit' : 'Preview'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void reload()} disabled={busy || isValidating} title="Discard edits and reload from Instantly">
            <RotateCcw /> Reload
          </Button>
        </div>
      </div>

      {data.pending && (
        <div role="status" className="flex items-center gap-2 rounded-lg border border-amber/30 bg-amber/10 px-3 py-2 text-[12px] text-fg">
          <Clock3 className="size-3.5 shrink-0 text-amber" />
          <span className="min-w-0 flex-1 truncate">A sequence change is already waiting for your approval{data.pending.summary ? `: ${data.pending.summary}` : '.'}</span>
          <Link href={`/actions/${data.pending.id}`} className="shrink-0 font-medium text-fg hover:underline">
            Review →
          </Link>
        </div>
      )}

      {steps.length === 0 && !draft ? (
        <div className="rounded-xl border border-dashed border-border p-6 text-center text-[13px] text-fg-46">
          This campaign has no sequence yet.
          <div className="mt-3">
            <Button size="sm" variant="outline" onClick={() => update(() => [{ delay: 0, delay_unit: 'days', variants: [{ subject: '', body: '' }] }])}>
              <Plus /> Write the first email
            </Button>
          </div>
        </div>
      ) : (
        <ol className="flex flex-col gap-3">
          {steps.map((st, i) => (
            <li key={i} className="rounded-xl border border-border bg-(--glass-fill) p-3">
              <div className="mb-2 flex flex-wrap items-center gap-2 text-[12px]">
                <span className="flex size-5 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">{i + 1}</span>
                <span className="font-medium text-fg">Step {i + 1}</span>
                {i === 0 ? (
                  <span className="text-fg-46">sent first</span>
                ) : preview ? (
                  <span className="text-fg-46">
                    wait {st.delay} {st.delay_unit}
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 text-fg-46">
                    wait
                    <Input
                      type="number"
                      min={0}
                      max={366}
                      value={st.delay}
                      onChange={(e) => update((s) => ((s[i].delay = Math.max(0, Number(e.target.value) || 0)), s))}
                      className="h-7 w-16 text-[12px]"
                      aria-label={`Step ${i + 1} delay`}
                    />
                    <SimpleSelect
                      size="sm"
                      value={st.delay_unit}
                      onValueChange={(v) => update((s) => ((s[i].delay_unit = v as DelayUnit), s))}
                      options={UNITS}
                      aria-label={`Step ${i + 1} delay unit`}
                      className="w-24"
                    />
                    after the previous email
                  </span>
                )}
                {!preview && steps.length > 1 && (
                  <Button size="icon-sm" variant="ghost" className="ml-auto" aria-label={`Remove step ${i + 1}`} onClick={() => update((s) => s.filter((_, k) => k !== i))}>
                    <Trash2 />
                  </Button>
                )}
              </div>

              <div className="flex flex-col gap-2">
                {st.variants.map((v, j) => (
                  <div key={j} className={cn('rounded-lg border border-border p-2.5', v.disabled && 'opacity-55')}>
                    <div className="mb-1.5 flex items-center gap-2 text-[11px] text-fg-46">
                      <span className="font-medium text-fg-70">Variant {variantLetter(j)}</span>
                      {!preview && (
                        <>
                          <label className="ml-auto flex items-center gap-1.5">
                            <Switch size="sm" checked={!v.disabled} onCheckedChange={(on) => setVariant(i, j, { disabled: !on })} aria-label={`Variant ${variantLetter(j)} enabled`} />
                            {v.disabled ? 'off' : 'on'}
                          </label>
                          {st.variants.length > 1 && (
                            <Button size="icon-xs" variant="ghost" aria-label={`Remove variant ${variantLetter(j)}`} onClick={() => update((s) => ((s[i].variants = s[i].variants.filter((_, k) => k !== j)), s))}>
                              <Trash2 />
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                    {preview ? (
                      <div className="space-y-1.5">
                        <p className="text-[13px] font-medium text-fg">{v.subject ? previewVariables(v.subject) : <span className="text-fg-46">(same thread)</span>}</p>
                        <p className="text-[13px] whitespace-pre-wrap text-fg-70">{previewVariables(v.body)}</p>
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        <Input
                          value={v.subject}
                          onChange={(e) => setVariant(i, j, { subject: e.target.value })}
                          placeholder={i === 0 ? 'Subject' : 'Subject (empty = reply in the same thread)'}
                          aria-label={`Step ${i + 1} variant ${variantLetter(j)} subject`}
                          className="h-8 text-[13px]"
                        />
                        <Textarea
                          value={v.body}
                          onChange={(e) => setVariant(i, j, { body: e.target.value })}
                          placeholder="Email body"
                          aria-label={`Step ${i + 1} variant ${variantLetter(j)} body`}
                          className="min-h-24 text-[13px]"
                        />
                        {variablesIn(`${v.subject} ${v.body}`).length > 0 && (
                          <p className="text-[11px] text-fg-46">Variables: {variablesIn(`${v.subject} ${v.body}`).map((x) => `{{${x}}}`).join(' ')}</p>
                        )}
                      </div>
                    )}
                  </div>
                ))}
                {!preview && st.variants.length < MAX_VARIANTS && (
                  <button
                    type="button"
                    onClick={() => update((s) => (s[i].variants.push({ subject: s[i].variants[0]?.subject ?? '', body: '' }), s))}
                    className="self-start text-[12px] text-fg-46 hover:text-fg"
                  >
                    + Add variant {variantLetter(st.variants.length)}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}

      {!preview && steps.length > 0 && steps.length < MAX_STEPS && (
        <Button size="sm" variant="outline" onClick={() => update((s) => [...s, { delay: 3, delay_unit: 'days', variants: [{ subject: '', body: '' }] }])}>
          <Plus /> Add follow-up step
        </Button>
      )}

      {problems.length > 0 && (
        <div role="alert" className="rounded-lg border border-red/30 bg-red/10 px-3 py-2 text-[12px] text-fg">
          {sopBlocked && <p className="mb-1 font-medium">Blocked by the cold-email SOP — fix these and request again:</p>}
          <ul className="list-inside list-disc">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {sopWarnings.length > 0 && (
        <div role="status" className="rounded-lg border border-amber/30 bg-amber/10 px-3 py-2 text-[12px] text-fg">
          <p className="mb-1 font-medium">Cold-email SOP warnings (not blocking):</p>
          <ul className="list-inside list-disc">
            {sopWarnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      {notice && <ActionNotice state={notice} onDismiss={() => setNotice(null)} />}

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
        <span className="mr-auto text-[12px] text-fg-46">{draft ? diffSummary(diff) : 'No edits yet'}</span>
        <Button size="sm" variant="ghost" disabled={!draft || busy} onClick={() => setDraft(null)}>
          Discard
        </Button>
        <Button size="sm" disabled={!draft || !diff.length || busy} onClick={() => void save()}>
          {busy ? 'Requesting…' : 'Request change'}
        </Button>
      </div>
    </div>
  )
}
