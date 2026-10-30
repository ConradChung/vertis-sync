import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

/**
 * The cold-email SOP (`lume/sops/cold-email-sop.md`): a YAML front-matter
 * block of machine rules (linted by `lib/copy/sopLint.ts`) and the owner's
 * prose below it. One file is the source of truth for the agent's system
 * prompt (`sopPromptBlock`), the `update_sequence` lint gate and the PDF
 * (`sops/cold-email-sop.Rmd`).
 *
 * A malformed SOP throws `SopError` — in `tests/copy/sop.test.ts`, in
 * `next.config.ts` (build, dev and start), and on every load at runtime — so
 * linting is never silently skipped.
 *
 * Bundling: read from disk at `process.cwd()/sops/cold-email-sop.md`;
 * `outputFileTracingIncludes` in `next.config.ts` ships it with every server
 * function.
 */

export const SOP_RELATIVE_PATH = path.join('sops', 'cold-email-sop.md')

export class SopError extends Error {
  constructor(message: string) {
    super(`Cold-email SOP is invalid: ${message}`)
    this.name = 'SopError'
  }
}

const text = z.string().trim().min(1)
const range = z
  .object({ min: z.number().int().min(0), max: z.number().int().positive() })
  .strict()
  .refine((r) => r.min <= r.max, { message: 'min must be <= max' })

export const SopRulesSchema = z
  .object({
    version: z.literal(1),
    placeholder: z.boolean(),
    banned_phrases: z.array(text),
    word_count: z.object({ step1: range, followup: range }).strict(),
    subject: z
      .object({
        casing: z.enum(['lowercase', 'sentence', 'any']),
        max_words: z.number().int().positive(),
        allowed_capitalized: z.array(text).default([]),
      })
      .strict(),
    proof_points: z
      .array(z.object({ id: z.string().regex(/^[a-z0-9_]+$/, 'snake_case id'), patterns: z.array(text).min(1) }).strict())
      .refine((pp) => new Set(pp.map((p) => p.id)).size === pp.length, { message: 'proof point ids must be unique' }),
    personalization_fields: z.array(z.string().regex(/^[A-Za-z_][\w.]*$/, 'a {{variable}} name')).min(1),
    max_personalization_fields_per_email: z.number().int().min(0),
    step1_cta: z.object({ forbid_yes_no_meeting: z.boolean(), meeting_words: z.array(text) }).strict(),
    fallbacks: z.object({ open_role: text, door_count: text, pms: text, jurisdiction: text, generic: text }).strict(),
  })
  .strict()

export type SopRules = z.infer<typeof SopRulesSchema>
export interface Sop {
  rules: SopRules
  /** The prose under the front matter, trimmed. */
  prose: string
}

const FRONT_MATTER = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/

/** Parse the SOP file's text. Throws `SopError` on anything malformed. */
export function parseSop(raw: string): Sop {
  const src = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const m = FRONT_MATTER.exec(src)
  if (!m) throw new SopError('missing the YAML front matter block (--- … ---) at the top')
  let data: unknown
  try {
    data = parseYaml(m[1], { strict: true, uniqueKeys: true })
  } catch (err) {
    throw new SopError(`front matter is not valid YAML: ${err instanceof Error ? err.message : String(err)}`)
  }
  const parsed = SopRulesSchema.safeParse(data)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new SopError(issues)
  }
  return { rules: parsed.data, prose: src.slice(m[0].length).trim() }
}

let cached: { sop: Sop; block: string } | null = null

/**
 * The committed SOP, read from disk. Cached per process in production (the
 * file only changes with a deploy); re-read on every call elsewhere so an
 * edit shows up in dev without a restart. Throws `SopError`.
 */
export function loadSop(): Sop {
  if (cached && process.env.NODE_ENV === 'production') return cached.sop
  const file = path.join(process.cwd(), SOP_RELATIVE_PATH)
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    throw new SopError(`cannot read ${SOP_RELATIVE_PATH}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const sop = parseSop(raw)
  cached = { sop, block: sopPromptBlock(sop) }
  return sop
}

const quoted = (xs: string[]) => xs.map((x) => `"${x}"`).join(', ')

/**
 * The SOP as its own cached system block: a compact summary of the machine
 * rules, then the owner's prose verbatim. Deterministic (no timestamps) so
 * the cache prefix stays stable until the file changes.
 */
export function sopPromptBlock(sop: Sop): string {
  const r = sop.rules
  const casing =
    r.subject.casing === 'lowercase'
      ? 'all lowercase'
      : r.subject.casing === 'sentence'
        ? 'sentence case (first letter capital, no Title Case)'
        : 'any casing'
  const lines = [
    "Cold-email SOP (Conrad's). Follow it for every email you draft or edit. update_campaign_sequence is linted against these rules; a violation refuses the request.",
    ...(r.placeholder ? ['Note: the SOP still holds placeholder values; follow them until Conrad replaces them.'] : []),
    '',
    'Rules (enforced):',
    `- Banned phrases (never in a subject or body): ${quoted(r.banned_phrases) || 'none'}.`,
    `- Body length: step 1 ${r.word_count.step1.min}-${r.word_count.step1.max} words; follow-ups ${r.word_count.followup.min}-${r.word_count.followup.max} words (a {{variable}} counts as one word).`,
    `- Subjects: ${casing}, at most ${r.subject.max_words} words${r.subject.allowed_capitalized.length ? `; may keep capitals: ${r.subject.allowed_capitalized.join(', ')}` : ''}. An empty subject on a follow-up keeps the same thread.`,
    `- Proof points, each at most once per sequence thread (any step or variant): ${r.proof_points.map((p) => `${p.id} (${quoted(p.patterns)})`).join('; ') || 'none'}.`,
    `- Personalization variables: ${r.personalization_fields.map((f) => `{{${f}}}`).join(', ')}; at most ${r.max_personalization_fields_per_email} personalization variable${r.max_personalization_fields_per_email === 1 ? '' : 's'} per email.`,
    ...(r.step1_cta.forbid_yes_no_meeting
      ? [`- Step 1 never asks a question about meeting (${quoted(r.step1_cta.meeting_words)}, or "N minutes"); ask for interest instead.`]
      : []),
    '- Fallback sentences (use the one for the field when a lead may lack it; never invent a value):',
    ...Object.entries(r.fallbacks).map(([k, v]) => `  - ${k}: ${v}`),
    '',
    'SOP text:',
    sop.prose,
  ]
  return lines.join('\n')
}

/** The cached prompt block for the committed SOP. Throws `SopError`. */
export function loadSopPromptBlock(): string {
  const sop = loadSop()
  return cached?.sop === sop ? cached.block : sopPromptBlock(sop)
}
