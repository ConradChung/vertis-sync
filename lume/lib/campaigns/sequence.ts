import { z } from 'zod'

/**
 * Instantly sequence editing (Campaigns → Sequence). Pure and client-safe.
 *
 * Instantly v2 (`PATCH /campaigns/{id}`, `sequences[0].steps`): each step is
 * `{ type: 'email', delay, delay_unit?, variants: [{ subject, body, v_disabled? }] }`;
 * `delay` is the wait before the step (unit `delay_unit`, default days, total
 * at most 366 days); bodies are HTML (`<br/>` for line breaks).
 *
 * The editor works on plain text (`EditStep`). A variant keeps `ref` (its
 * step/variant position in the sequence it was loaded from) so an untouched
 * variant is sent back with its original HTML, and only edited ones are
 * re-rendered from text (`toInstantlySteps`). Without a `ref` the variant at
 * the same position is the comparison.
 */

export type DelayUnit = 'minutes' | 'hours' | 'days'

export interface InstantlyVariant {
  subject: string
  body: string
  v_disabled?: boolean
}
export interface InstantlyStep {
  type: 'email'
  delay: number
  delay_unit?: DelayUnit
  variants: InstantlyVariant[]
}

export interface EditVariant {
  subject: string
  body: string
  disabled?: boolean
  /** [step, variant] index in the loaded sequence; absent for new variants. */
  ref?: [number, number]
}
export interface EditStep {
  delay: number
  delay_unit: DelayUnit
  variants: EditVariant[]
}

export const MAX_STEPS = 20
export const MAX_VARIANTS = 26
const MAX_TOTAL_MINUTES = 366 * 24 * 60
const UNIT_MINUTES: Record<DelayUnit, number> = { minutes: 1, hours: 60, days: 1440 }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const s = (v: unknown) => (typeof v === 'string' ? v : '')

/** `GET /campaigns/{id}` body → the first sequence's steps, keeping only the documented fields. */
export function readInstantlySteps(body: unknown): InstantlyStep[] {
  if (!isObj(body) || !Array.isArray(body.sequences)) return []
  const first = body.sequences[0]
  if (!isObj(first) || !Array.isArray(first.steps)) return []
  return first.steps.filter(isObj).map((st) => {
    const unit = st.delay_unit === 'minutes' || st.delay_unit === 'hours' || st.delay_unit === 'days' ? st.delay_unit : undefined
    const step: InstantlyStep = {
      type: 'email',
      delay: typeof st.delay === 'number' && Number.isFinite(st.delay) ? st.delay : 0,
      variants: (Array.isArray(st.variants) ? st.variants : []).filter(isObj).map((v) => {
        const out: InstantlyVariant = { subject: s(v.subject), body: s(v.body) }
        if (v.v_disabled === true) out.v_disabled = true
        return out
      }),
    }
    if (unit) step.delay_unit = unit
    return step
  })
}

/** Canonical JSON of the steps (fixed key order), the input of the stale-edit hash. */
export function canonicalSteps(steps: InstantlyStep[]): string {
  return JSON.stringify(
    steps.map((st) => [st.delay, st.delay_unit ?? 'days', st.variants.map((v) => [v.subject, v.body, v.v_disabled === true])])
  )
}

const ENTITIES: [RegExp, string][] = [
  [/&nbsp;/g, ' '],
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&quot;/g, '"'],
  [/&#39;/g, "'"],
  [/&amp;/g, '&'],
]

/** Instantly HTML body → editable plain text (line breaks kept). */
export function htmlToText(html: string): string {
  const isHtml = /<[a-z!/][^>]*>/i.test(html)
  let t = html.replace(/\r\n?/g, '\n')
  // Newlines in HTML source are not line breaks; in a plain-text body they are.
  if (isHtml) t = t.replace(/\n/g, '')
  t = t
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
  for (const [re, ch] of ENTITIES) t = t.replace(re, ch)
  return t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

const escapeHtml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Plain text → Instantly body: escaped, one `<div>` per line, `<br/>` for blank lines. */
export function textToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => (line.trim() ? `<div>${escapeHtml(line)}</div>` : '<div><br/></div>'))
    .join('')
}

/** Loaded steps → editor state. */
export function toEditSteps(steps: InstantlyStep[]): EditStep[] {
  return steps.map((st, i) => ({
    delay: st.delay,
    delay_unit: st.delay_unit ?? 'days',
    variants: st.variants.map((v, j) => {
      const out: EditVariant = { subject: v.subject, body: htmlToText(v.body), ref: [i, j] }
      if (v.v_disabled) out.disabled = true
      return out
    }),
  }))
}

/**
 * Editor state → the steps to PATCH. A variant whose text still equals its
 * original's (same `ref`) keeps the original HTML byte for byte; anything
 * else is rendered from the text. Delay units of the original are kept.
 */
export function toInstantlySteps(edited: EditStep[], original: InstantlyStep[]): InstantlyStep[] {
  return edited.map((st, i) => ({
    type: 'email' as const,
    delay: st.delay,
    delay_unit: st.delay_unit,
    variants: st.variants.map((v, j) => {
      // No ref (the agent's full rewrite): compare against the same position.
      const o = v.ref ? original[v.ref[0]]?.variants[v.ref[1]] : original[i]?.variants[j]
      const body = o && htmlToText(o.body) === v.body.trim() ? o.body : textToHtml(v.body.trim())
      const out: InstantlyVariant = { subject: v.subject.trim(), body }
      if (v.disabled) out.v_disabled = true
      return out
    }),
  }))
}

const variantSchema = z.object({
  subject: z.string().max(500),
  body: z.string().max(20_000),
  disabled: z.boolean().optional(),
  ref: z.tuple([z.number().int().min(0), z.number().int().min(0)]).optional(),
})
export const editStepsSchema = z
  .array(
    z.object({
      delay: z.number().min(0).max(527_040),
      delay_unit: z.enum(['minutes', 'hours', 'days']),
      variants: z.array(variantSchema).min(1).max(MAX_VARIANTS),
    })
  )
  .min(1)
  .max(MAX_STEPS)

/** Business rules on top of the shape: copy present, first email has a subject, total delay ≤ 366 days. */
export function sequenceProblems(steps: EditStep[]): string[] {
  const out: string[] = []
  let minutes = 0
  steps.forEach((st, i) => {
    minutes += st.delay * UNIT_MINUTES[st.delay_unit]
    if (!st.variants.some((v) => !v.disabled)) out.push(`Step ${i + 1}: at least one variant must be enabled.`)
    st.variants.forEach((v, j) => {
      const label = `Step ${i + 1}${st.variants.length > 1 ? ` variant ${variantLetter(j)}` : ''}`
      if (!v.body.trim()) out.push(`${label}: the email body is empty.`)
      if (i === 0 && !v.subject.trim()) out.push(`${label}: the first email needs a subject.`)
    })
  })
  if (minutes > MAX_TOTAL_MINUTES) out.push('The delays add up to more than 366 days.')
  return out
}

export const variantLetter = (j: number) => String.fromCharCode(65 + (j % 26))

// ---------------------------------------------------------------------------
// Diff (approval page)

export type FieldChange = { field: 'subject' | 'body' | 'enabled'; before: string; after: string }
export type VariantDiff =
  | { variant: string; change: 'added'; after: EditVariant }
  | { variant: string; change: 'removed'; before: EditVariant }
  | { variant: string; change: 'changed'; fields: FieldChange[] }
export type StepDiff =
  | { step: number; change: 'added'; after: EditStep }
  | { step: number; change: 'removed'; before: EditStep }
  | { step: number; change: 'changed'; delay?: { before: string; after: string }; variants: VariantDiff[] }

export const delayLabel = (st: Pick<EditStep, 'delay' | 'delay_unit'>, index: number) =>
  index === 0 && st.delay === 0 ? 'sent first' : `wait ${st.delay} ${st.delay === 1 ? st.delay_unit.replace(/s$/, '') : st.delay_unit}`

/** Position-by-position diff of two plain-text sequences; unchanged steps are left out. */
export function diffSequences(before: EditStep[], after: EditStep[]): StepDiff[] {
  const out: StepDiff[] = []
  const n = Math.max(before.length, after.length)
  for (let i = 0; i < n; i++) {
    const b = before[i]
    const a = after[i]
    if (!b && a) {
      out.push({ step: i + 1, change: 'added', after: a })
      continue
    }
    if (b && !a) {
      out.push({ step: i + 1, change: 'removed', before: b })
      continue
    }
    const variants: VariantDiff[] = []
    const m = Math.max(b.variants.length, a.variants.length)
    for (let j = 0; j < m; j++) {
      const bv = b.variants[j]
      const av = a.variants[j]
      const letter = variantLetter(j)
      if (!bv && av) variants.push({ variant: letter, change: 'added', after: av })
      else if (bv && !av) variants.push({ variant: letter, change: 'removed', before: bv })
      else {
        const fields: FieldChange[] = []
        if (bv.subject.trim() !== av.subject.trim()) fields.push({ field: 'subject', before: bv.subject, after: av.subject })
        if (bv.body.trim() !== av.body.trim()) fields.push({ field: 'body', before: bv.body, after: av.body })
        if (!!bv.disabled !== !!av.disabled) {
          fields.push({ field: 'enabled', before: bv.disabled ? 'off' : 'on', after: av.disabled ? 'off' : 'on' })
        }
        if (fields.length) variants.push({ variant: letter, change: 'changed', fields })
      }
    }
    const db = delayLabel(b, i)
    const da = delayLabel(a, i)
    const delay = db !== da ? { before: db, after: da } : undefined
    if (delay || variants.length) out.push({ step: i + 1, change: 'changed', ...(delay ? { delay } : {}), variants })
  }
  return out
}

export function diffSummary(d: StepDiff[]): string {
  const added = d.filter((x) => x.change === 'added').length
  const removed = d.filter((x) => x.change === 'removed').length
  const changed = d.filter((x) => x.change === 'changed').length
  const parts: string[] = []
  if (changed) parts.push(`${changed} step${changed === 1 ? '' : 's'} edited`)
  if (added) parts.push(`${added} added`)
  if (removed) parts.push(`${removed} removed`)
  return parts.join(', ') || 'no changes'
}

// ---------------------------------------------------------------------------
// Variable preview

export const SAMPLE_LEAD: Record<string, string> = {
  firstName: 'Alex',
  lastName: 'Rivera',
  companyName: 'Northwind Roofing',
  website: 'northwindroofing.com',
  location: 'Austin, TX',
  personalization: 'Saw your crew finished the Elm St job last week.',
  sendingAccountFirstName: 'Conrad',
  accountSignature: 'Conrad',
}

/** `{{var}}` → sample values; unknown variables stay visible as `[var]`. Instantly spintax is left as is. */
export function previewVariables(text: string, sample: Record<string, string> = SAMPLE_LEAD): string {
  return text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, name: string) => sample[name] ?? `[${name}]`)
}

export const variablesIn = (text: string) => [...new Set([...text.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]))]
