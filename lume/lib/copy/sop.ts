import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

/**
 * Cold-email SOPs. `lume/sops/cold-email-sop.md` is the base (general rules
 * and generic fallbacks); `lume/sops/clients/<client>.md` are client overlays
 * with the same YAML header shape plus a `client`, `name` and `match` block,
 * and their own prose. Each file is a YAML front-matter block of machine
 * rules (linted by `lib/copy/sopLint.ts`) followed by prose.
 *
 * Overlay merge (`mergeRules`): `banned_phrases` extend the base (union);
 * the object sections (`word_count`, `subject`, `step1_cta`, `fallbacks`,
 * `only_in_step`, `step_rules`, `signoff`) merge key by key, the overlay's
 * key winning (a `step_rules` step is replaced whole); every other key the
 * overlay sets replaces the base's. The merged rules are re-validated.
 *
 * Selection: the `update_sequence` lint uses base + the overlay whose `match`
 * fits the target campaign (`sopForCampaign`: name contains one of
 * `campaign_names`, case-insensitive, or the id is in `campaign_ids`; two
 * overlays matching one campaign is an error). The agent's system block gets
 * base + the overlay for the chat's vertical or project when one matches
 * (`clientForContext`), else the list of overlays and the `get_sop` tool.
 *
 * Anything malformed throws `SopError` — in `tests/copy/sop.test.ts`, in
 * `next.config.ts` (build, dev and start), and on every load at runtime — so
 * linting is never silently skipped.
 *
 * Bundling: read from disk under `process.cwd()/sops/`;
 * `outputFileTracingIncludes` in `next.config.ts` ships `sops/**` with every
 * server function.
 */

export const SOP_DIR = 'sops'
export const BASE_FILE = 'cold-email-sop.md'
export const CLIENTS_DIR = 'clients'

export class SopError extends Error {
  constructor(message: string) {
    super(`Cold-email SOP is invalid: ${message}`)
    this.name = 'SopError'
  }
}

const text = z.string().trim().min(1)
const isRegex = (s: string) => {
  try {
    new RegExp(s, 'iu')
    return true
  } catch {
    return false
  }
}
const regex = text.refine(isRegex, { message: 'not a valid regular expression' })
const stepKey = z.string().regex(/^[1-9]\d*$/, 'a step number')
const range = z
  .object({ min: z.number().int().min(0), max: z.number().int().positive() })
  .strict()
  .refine((r) => r.min <= r.max, { message: 'min must be <= max' })
const casing = z.enum(['lowercase', 'sentence', 'any'])
const proofPoints = z
  .array(z.object({ id: z.string().regex(/^[a-z0-9_]+$/, 'snake_case id'), patterns: z.array(regex).min(1) }).strict())
  .refine((pp) => new Set(pp.map((p) => p.id)).size === pp.length, { message: 'proof point ids must be unique' })
const fieldName = z.string().regex(/^[A-Za-z_][\w.]*$/, 'a {{variable}} name')
const stepRule = z
  .object({
    forbid: z.array(text).default([]),
    require: z.array(z.object({ pattern: regex, label: text }).strict()).default([]),
  })
  .strict()
const sequenceShape = z
  .object({
    steps: z.number().int().positive().optional(),
    delays_days: z.array(z.number().min(0)).optional(),
    step1_variants: z.number().int().positive().optional(),
  })
  .strict()
const FALLBACK_KEYS = ['open_role', 'door_count', 'pms', 'jurisdiction', 'generic'] as const

/** The full (base or merged) rule set. Keys added after v1 are optional with defaults. */
export const SopRulesSchema = z
  .object({
    version: z.literal(1),
    placeholder: z.boolean(),
    banned_phrases: z.array(text),
    no_exclamation: z.boolean().default(false),
    word_count: z.object({ step1: range, followup: range }).strict(),
    subject: z
      .object({
        casing,
        min_words: z.number().int().min(0).default(0),
        max_words: z.number().int().positive(),
        allowed_capitalized: z.array(text).default([]),
        /** No {{company}} / {{companyName}} in a subject. */
        no_company: z.boolean().default(false),
        /** Phrases a subject may not contain (whole words, case-insensitive). */
        forbid: z.array(text).default([]),
      })
      .strict()
      .refine((s) => s.min_words <= s.max_words, { message: 'min_words must be <= max_words' }),
    proof_points: proofPoints,
    max_proof_points_per_email: z.number().int().min(0).nullable().default(null),
    /** Phrase → the only steps it may appear in. */
    only_in_step: z.record(text, z.array(z.number().int().min(1)).min(1)).default({}),
    personalization_fields: z.array(fieldName).min(1),
    max_personalization_fields_per_email: z.number().int().min(0),
    step1_cta: z
      .object({
        forbid_yes_no_meeting: z.boolean(),
        meeting_words: z.array(text),
        meeting_patterns: z.array(regex).default([]),
      })
      .strict(),
    step_rules: z.record(stepKey, stepRule).default({}),
    signoff: z.record(stepKey, text).default({}),
    sequence: sequenceShape.nullable().default(null),
    fallbacks: z
      .object(Object.fromEntries(FALLBACK_KEYS.map((k) => [k, text])) as Record<(typeof FALLBACK_KEYS)[number], typeof text>)
      .catchall(text),
  })
  .strict()

export type SopRules = z.output<typeof SopRulesSchema>
type RulesInput = z.input<typeof SopRulesSchema>

/** A client overlay's header: identity, match, and any subset of the rules. */
const OverlaySchema = z
  .object({
    version: z.literal(1),
    client: z.string().regex(/^[a-z0-9_-]+$/, 'lowercase client id'),
    name: text,
    placeholder: z.boolean().optional(),
    match: z
      .object({
        campaign_names: z.array(text).default([]),
        campaign_ids: z.array(text).default([]),
        vertical: text.nullable().default(null),
      })
      .strict()
      .refine((m) => m.campaign_names.length + m.campaign_ids.length > 0 || m.vertical, { message: 'match needs campaign_names, campaign_ids or vertical' }),
    banned_phrases: z.array(text).optional(),
    no_exclamation: z.boolean().optional(),
    word_count: z.object({ step1: range, followup: range }).partial().strict().optional(),
    subject: z
      .object({
        casing,
        min_words: z.number().int().min(0),
        max_words: z.number().int().positive(),
        allowed_capitalized: z.array(text),
        no_company: z.boolean(),
        forbid: z.array(text),
      })
      .partial()
      .strict()
      .optional(),
    proof_points: proofPoints.optional(),
    max_proof_points_per_email: z.number().int().min(0).nullable().optional(),
    only_in_step: z.record(text, z.array(z.number().int().min(1)).min(1)).optional(),
    personalization_fields: z.array(fieldName).min(1).optional(),
    max_personalization_fields_per_email: z.number().int().min(0).optional(),
    step1_cta: z
      .object({ forbid_yes_no_meeting: z.boolean(), meeting_words: z.array(text), meeting_patterns: z.array(regex) })
      .partial()
      .strict()
      .optional(),
    step_rules: z.record(stepKey, stepRule).optional(),
    signoff: z.record(stepKey, text).optional(),
    sequence: sequenceShape.nullable().optional(),
    fallbacks: z.record(z.string(), text).optional(),
  })
  .strict()
export type SopOverlay = z.output<typeof OverlaySchema>

export interface Sop {
  rules: SopRules
  /** The prose under the front matter, trimmed. */
  prose: string
}
export interface ClientSop {
  client: string
  name: string
  match: SopOverlay['match']
  overlay: SopOverlay
  /** Base + overlay, validated. */
  rules: SopRules
  prose: string
}
export interface SopLibrary {
  base: Sop
  clients: ClientSop[]
}

const FRONT_MATTER = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/

function splitFrontMatter(raw: string, label: string): { data: unknown; prose: string } {
  const src = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const m = FRONT_MATTER.exec(src)
  if (!m) throw new SopError(`${label}: missing the YAML front matter block (--- … ---) at the top`)
  try {
    return { data: parseYaml(m[1], { strict: true, uniqueKeys: true }), prose: src.slice(m[0].length).trim() }
  } catch (err) {
    throw new SopError(`${label}: front matter is not valid YAML: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function check<T extends z.ZodType>(schema: T, data: unknown, label: string): z.output<T> {
  const parsed = schema.safeParse(data)
  if (parsed.success) return parsed.data
  const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
  throw new SopError(`${label}: ${issues}`)
}

/** Parse the base SOP file's text. Throws `SopError` on anything malformed. */
export function parseSop(raw: string, label = BASE_FILE): Sop {
  const { data, prose } = splitFrontMatter(raw, label)
  return { rules: check(SopRulesSchema, data, label), prose }
}

/** Parse a client overlay file's text. Throws `SopError`. */
export function parseOverlay(raw: string, label = 'client SOP'): { overlay: SopOverlay; prose: string } {
  const { data, prose } = splitFrontMatter(raw, label)
  return { overlay: check(OverlaySchema, data, label), prose }
}

/** Base + overlay (see the header for the merge policy), re-validated. Throws `SopError`. */
export function mergeRules(base: SopRules, o: SopOverlay, label = o.client): SopRules {
  const union = (a: string[], b: string[]) => {
    const seen = new Set(a.map((x) => x.toLowerCase()))
    return [...a, ...b.filter((x) => !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()))]
  }
  const merged: RulesInput = {
    ...base,
    placeholder: o.placeholder ?? base.placeholder,
    banned_phrases: union(base.banned_phrases, o.banned_phrases ?? []),
    no_exclamation: o.no_exclamation ?? base.no_exclamation,
    word_count: { ...base.word_count, ...o.word_count },
    subject: { ...base.subject, ...o.subject },
    proof_points: o.proof_points ?? base.proof_points,
    max_proof_points_per_email: o.max_proof_points_per_email !== undefined ? o.max_proof_points_per_email : base.max_proof_points_per_email,
    only_in_step: { ...base.only_in_step, ...o.only_in_step },
    personalization_fields: o.personalization_fields ?? base.personalization_fields,
    max_personalization_fields_per_email: o.max_personalization_fields_per_email ?? base.max_personalization_fields_per_email,
    step1_cta: { ...base.step1_cta, ...o.step1_cta },
    step_rules: { ...base.step_rules, ...o.step_rules },
    signoff: { ...base.signoff, ...o.signoff },
    sequence: o.sequence !== undefined ? o.sequence : base.sequence,
    fallbacks: { ...base.fallbacks, ...o.fallbacks },
  }
  return check(SopRulesSchema, merged, `${label} (merged with the base)`)
}

/** Build the library from file texts (pure; `loadSopLibrary` reads them from disk). */
export function buildSopLibrary(baseRaw: string, clientFiles: { file: string; raw: string }[]): SopLibrary {
  const base = parseSop(baseRaw)
  const clients: ClientSop[] = []
  for (const { file, raw } of clientFiles) {
    const label = `${CLIENTS_DIR}/${file}`
    const { overlay, prose } = parseOverlay(raw, label)
    if (`${overlay.client}.md` !== file) throw new SopError(`${label}: client "${overlay.client}" must live in ${CLIENTS_DIR}/${overlay.client}.md`)
    clients.push({ client: overlay.client, name: overlay.name, match: overlay.match, overlay, rules: mergeRules(base.rules, overlay, label), prose })
  }
  return { base, clients }
}

let cached: SopLibrary | null = null
const sopPath = (...parts: string[]) => path.join(process.cwd(), SOP_DIR, ...parts)
function read(file: string, label: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch (err) {
    throw new SopError(`cannot read ${label}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * The committed SOPs, read from disk. Cached per process in production (they
 * only change with a deploy); re-read on every call elsewhere so an edit
 * shows up in dev without a restart. Throws `SopError`.
 */
export function loadSopLibrary(): SopLibrary {
  if (cached && process.env.NODE_ENV === 'production') return cached
  const baseRaw = read(sopPath(BASE_FILE), `${SOP_DIR}/${BASE_FILE}`)
  let files: string[] = []
  try {
    files = readdirSync(sopPath(CLIENTS_DIR)).filter((f) => f.endsWith('.md')).sort()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new SopError(`cannot list ${SOP_DIR}/${CLIENTS_DIR}: ${String(err)}`)
  }
  const clientFiles = files.map((file) => ({ file, raw: read(sopPath(CLIENTS_DIR, file), `${SOP_DIR}/${CLIENTS_DIR}/${file}`) }))
  cached = buildSopLibrary(baseRaw, clientFiles)
  return cached
}

/** The base SOP alone. Throws `SopError`. */
export function loadSop(): Sop {
  return loadSopLibrary().base
}

/** The overlay for a campaign (by name substring or id), or null. Two matches throw `SopError`. */
export function clientForCampaign(lib: SopLibrary, campaign: { id?: string | null; name?: string | null }): ClientSop | null {
  const name = (campaign.name ?? '').toLowerCase()
  const hits = lib.clients.filter(
    (c) =>
      (campaign.id && c.match.campaign_ids.includes(campaign.id)) ||
      (name && c.match.campaign_names.some((n) => name.includes(n.toLowerCase())))
  )
  if (hits.length > 1) {
    throw new SopError(`campaign "${campaign.name ?? campaign.id}" matches more than one client SOP (${hits.map((c) => c.client).join(', ')}); narrow their match blocks`)
  }
  return hits[0] ?? null
}

/** The rules the `update_sequence` lint applies to a campaign: base + its overlay. Throws `SopError`. */
export function sopForCampaign(campaign: { id?: string | null; name?: string | null }, lib = loadSopLibrary()): { rules: SopRules; client: string | null } {
  const c = clientForCampaign(lib, campaign)
  return { rules: c ? c.rules : lib.base.rules, client: c?.client ?? null }
}

/**
 * The overlay for an agent chat, from its vertical's or project's name: a
 * vertical equal to `match.vertical` (case-insensitive), or a vertical or
 * project name that contains the client id, its name, or one of its
 * `campaign_names`. Null when none or more than one fits.
 */
export function clientForContext(lib: SopLibrary, ctx: { vertical?: string | null; project?: string | null }): ClientSop | null {
  const names = [ctx.vertical, ctx.project].filter((x): x is string => !!x).map((x) => x.toLowerCase())
  if (!names.length) return null
  const hits = lib.clients.filter((c) => {
    if (c.match.vertical && ctx.vertical && c.match.vertical.toLowerCase() === ctx.vertical.toLowerCase()) return true
    const keys = [c.client, c.name, ...c.match.campaign_names].map((k) => k.toLowerCase())
    return names.some((n) => keys.some((k) => n.includes(k)))
  })
  return hits.length === 1 ? hits[0] : null
}

export function findClient(lib: SopLibrary, client: string): ClientSop | null {
  const k = client.trim().toLowerCase()
  return lib.clients.find((c) => c.client === k || c.name.toLowerCase() === k) ?? null
}

const quoted = (xs: string[]) => xs.map((x) => `"${x}"`).join(', ')

/** A compact summary of a rule set for the prompt. Deterministic. */
export function rulesSummary(r: SopRules): string {
  const casingText =
    r.subject.casing === 'lowercase' ? 'all lowercase' : r.subject.casing === 'sentence' ? 'sentence case (first letter capital, no Title Case)' : 'any casing'
  const subjectWords = r.subject.min_words > 0 ? `${r.subject.min_words}-${r.subject.max_words} words` : `at most ${r.subject.max_words} words`
  const stepRules = Object.entries(r.step_rules).sort(([a], [b]) => Number(a) - Number(b))
  const signoffs = Object.entries(r.signoff).sort(([a], [b]) => Number(a) - Number(b))
  const seq = r.sequence
  const lines = [
    `- Banned phrases (never in a subject or body): ${quoted(r.banned_phrases) || 'none'}.`,
    ...(r.no_exclamation ? ['- No exclamation marks anywhere.'] : []),
    `- Body length: step 1 ${r.word_count.step1.min}-${r.word_count.step1.max} words; follow-ups ${r.word_count.followup.min}-${r.word_count.followup.max} words (a {{variable}} counts as one word).`,
    `- Subjects: ${casingText}, ${subjectWords}${r.subject.allowed_capitalized.length ? `; may keep capitals: ${r.subject.allowed_capitalized.join(', ')}` : ''}${r.subject.no_company ? '; never the company name or {{companyName}}/{{company}}' : ''}${r.subject.forbid.length ? `; never ${quoted(r.subject.forbid)}` : ''}. An empty subject on a follow-up keeps the same thread.`,
    `- Proof points, each at most once per sequence thread (any step or variant)${r.max_proof_points_per_email !== null ? `, at most ${r.max_proof_points_per_email} per email` : ''}: ${r.proof_points.map((p) => p.id).join(', ') || 'none'}.`,
    ...Object.entries(r.only_in_step).map(([p, steps]) => `- "${p}" only in step ${steps.join(', ')}.`),
    `- Personalization variables: ${r.personalization_fields.map((f) => `{{${f}}}`).join(', ')}; at most ${r.max_personalization_fields_per_email} per email ({{company}} and {{companyName}} are the same field; {{firstName}} is not personalization).`,
    ...(r.step1_cta.forbid_yes_no_meeting
      ? [`- Step 1 never asks a question about meeting (${quoted(r.step1_cta.meeting_words)}${r.step1_cta.meeting_patterns.length ? ', or a meeting length' : ''}); ask a qualifying question instead.`]
      : []),
    ...stepRules.map(
      ([s, x]) =>
        `- Step ${s}: ${[x.forbid.length ? `never ${quoted(x.forbid)}` : '', ...x.require.map((q) => `must include ${q.label}`)].filter(Boolean).join('; ')}.`
    ),
    ...(signoffs.length ? [`- Sign-off (last line): ${signoffs.map(([s, n]) => `step ${s} "${n}"`).join(', ')}.`] : []),
    ...(seq
      ? [
          `- Sequence shape (warning only): ${[seq.steps ? `${seq.steps} steps` : '', seq.delays_days ? `delays ${seq.delays_days.join('/')} days` : '', seq.step1_variants ? `${seq.step1_variants} variants on step 1` : ''].filter(Boolean).join(', ')}.`,
        ]
      : []),
    '- Fallback sentences (use the one for the field when a lead lacks a high-confidence value; never invent a value):',
    ...Object.entries(r.fallbacks).map(([k, v]) => `  - ${k}: ${v}`),
  ]
  return lines.join('\n')
}

const matchText = (c: ClientSop) =>
  [
    c.match.campaign_names.length ? `campaigns whose name contains ${quoted(c.match.campaign_names)}` : '',
    c.match.campaign_ids.length ? `campaign ids ${c.match.campaign_ids.join(', ')}` : '',
    c.match.vertical ? `vertical "${c.match.vertical}"` : '',
  ]
    .filter(Boolean)
    .join('; ')

/** One client's SOP for the prompt or `get_sop`: merged rules + its prose. */
export function clientSopText(c: ClientSop): string {
  return [
    `Client SOP: ${c.name} (client id ${c.client}; applies to ${matchText(c)}). These rules are the base merged with ${c.name}'s and are what update_campaign_sequence lints its campaigns against.`,
    ...(c.rules.placeholder ? ['Note: this SOP still holds placeholder values.'] : []),
    '',
    'Rules (enforced):',
    rulesSummary(c.rules),
    '',
    `${c.name} SOP text:`,
    c.prose,
  ].join('\n')
}

/**
 * The SOP system block: base rules + prose, then either the chat's client
 * overlay or the list of overlays (load one with `get_sop`). Deterministic
 * (no timestamps) so the cache prefix stays stable until a file changes.
 */
export function sopPromptBlock(lib: SopLibrary, client: ClientSop | null = null): string {
  const b = lib.base
  const lines = [
    "Cold-email SOP (Conrad's). Follow it for every email you draft or edit. update_campaign_sequence is linted against the base rules plus the client SOP matching the campaign; a violation refuses the request.",
    ...(b.rules.placeholder ? ['Note: the base SOP still holds placeholder values; follow them until Conrad replaces them.'] : []),
    '',
    'Base rules (enforced unless a client SOP overrides them):',
    rulesSummary(b.rules),
    '',
    'Base SOP text:',
    b.prose,
    '',
  ]
  if (client) lines.push(clientSopText(client))
  else if (lib.clients.length) {
    lines.push(
      'Client SOPs (they extend or override the base for their campaigns):',
      ...lib.clients.map((c) => `- ${c.client}: ${c.name}; ${matchText(c)}`),
      'Before drafting or editing copy for one of these clients or campaigns, call get_sop with its client id and follow it.'
    )
  } else lines.push('No client SOPs yet.')
  return lines.join('\n')
}
