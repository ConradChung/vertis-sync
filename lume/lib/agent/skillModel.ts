/**
 * Saved agent skills: a pipeline the owner built once (actor → import →
 * validate → duplicate → assign → launch), stored as typed steps with
 * `{{variable}}` placeholders so it can be re-run or attached as reference.
 * Pure and client-safe: zod schemas, step labels and the prompt block the
 * run route injects. Storage lives in `lib/agent/skills.ts`.
 */
import { z } from 'zod'

const MAX_TEMPLATE_BYTES = 20_000
const note = z.string().trim().max(500).optional()
const loose = z.record(z.string(), z.unknown())

/** At most 20 kB of JSON, so one skill cannot flood the prompt. */
const boundedRecord = loose.refine((v) => JSON.stringify(v).length <= MAX_TEMPLATE_BYTES, 'too large')

export const skillStepSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('apify_actor'),
    actor_id: z.string().trim().min(1).max(200),
    actor_name: z.string().trim().max(200).optional(),
    input_template: boundedRecord.default({}),
    budget_usd: z.number().positive().max(20).optional(),
    note,
  }),
  z.strictObject({ type: z.literal('import'), note }),
  z.strictObject({ type: z.literal('validate'), note }),
  z.strictObject({
    type: z.literal('duplicate_campaign'),
    source_campaign_id: z.string().trim().min(1).max(200),
    source_campaign_name: z.string().trim().max(300).optional(),
    name_template: z.string().trim().min(1).max(200),
    note,
  }),
  z.strictObject({
    type: z.literal('assign_leads'),
    filter: boundedRecord.optional(),
    count: z.number().int().positive().max(100_000).optional(),
    note,
  }),
  z.strictObject({ type: z.literal('rotation_rule'), rule: boundedRecord, note }),
  z.strictObject({ type: z.literal('launch'), note }),
  z.strictObject({ type: z.literal('note'), text: z.string().trim().min(1).max(2000) }),
])
export type SkillStep = z.infer<typeof skillStepSchema>
export type SkillStepType = SkillStep['type']

export const skillVariableSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'lowercase letters, digits, _'),
  description: z.string().trim().max(300).default(''),
  default: z.string().max(500).optional(),
})
export type SkillVariable = z.infer<typeof skillVariableSchema>

export const skillName = z.string().trim().min(1).max(80)
export const skillDescription = z.string().trim().max(1000)

export const newSkillSchema = z
  .strictObject({
    name: skillName,
    description: skillDescription.default(''),
    steps: z.array(skillStepSchema).min(1).max(30),
    variables: z.array(skillVariableSchema).max(20).default([]),
    source_conversation_id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).nullable().optional(),
  })
  .refine((s) => new Set(s.variables.map((v) => v.name)).size === s.variables.length, {
    message: 'duplicate variable names',
    path: ['variables'],
  })
export type NewSkill = z.infer<typeof newSkillSchema>

export const skillPatchSchema = z
  .strictObject({ name: skillName.optional(), description: skillDescription.optional() })
  .refine((p) => p.name !== undefined || p.description !== undefined, 'nothing to update')

export interface Skill {
  id: string
  name: string
  description: string
  steps: SkillStep[]
  variables: SkillVariable[]
  source_conversation_id: string | null
  created_at: string
  updated_at: string
  last_run_at: string | null
  run_count: number
  /** Ships with Lume (lib/agent/builtinSkills.ts): listed and runnable, never renamed or deleted. */
  builtin?: boolean
}

export type SkillMode = 'run' | 'reference'

export const STEP_LABEL: Record<SkillStepType, string> = {
  apify_actor: 'Run Apify actor',
  import: 'Import results',
  validate: 'Validate',
  duplicate_campaign: 'Duplicate campaign',
  assign_leads: 'Assign leads',
  rotation_rule: 'Rotation rule',
  launch: 'Launch',
  note: 'Note',
}

/** One line per step, for the card, the manage view and the prompt. */
export function describeStep(step: SkillStep): string {
  switch (step.type) {
    case 'apify_actor':
      return `${STEP_LABEL.apify_actor}: ${step.actor_name || step.actor_id}${step.budget_usd ? ` (≤ $${step.budget_usd})` : ''}`
    case 'duplicate_campaign':
      return `${STEP_LABEL.duplicate_campaign}: ${step.source_campaign_name || step.source_campaign_id} → "${step.name_template}"`
    case 'assign_leads':
      return `${STEP_LABEL.assign_leads}${step.count ? `: ${step.count}` : ''}`
    case 'rotation_rule': {
      const name = typeof step.rule.name === 'string' ? step.rule.name : null
      return `${STEP_LABEL.rotation_rule}${name ? `: ${name}` : ''}`
    }
    case 'note':
      return `${STEP_LABEL.note}: ${step.text}`
    default:
      return step.note ? `${STEP_LABEL[step.type]}: ${step.note}` : STEP_LABEL[step.type]
  }
}

/** `{{name}}` placeholders used anywhere in the steps. */
export function placeholdersIn(steps: SkillStep[]): string[] {
  const found = new Set<string>()
  for (const m of JSON.stringify(steps).matchAll(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g)) found.add(m[1])
  return [...found]
}

const CONTEXT_MAX = 12_000

/**
 * The block the run route puts ahead of the owner's message. Run: execute the
 * steps, still asking for variables and every actor's inputs and filing an
 * approval for every high-risk step. Reference: context only.
 */
export function skillContext(skill: Skill, mode: SkillMode): string {
  const body = JSON.stringify({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    variables: skill.variables,
    steps: skill.steps,
  })
  const json = body.length > CONTEXT_MAX ? `${body.slice(0, CONTEXT_MAX)}… [truncated; call get_skill for the rest]` : body
  const outline = skill.steps.map((s, i) => `${i + 1}. ${describeStep(s)}`).join('\n')
  if (mode === 'run') {
    return [
      `The owner chose to RUN the saved skill "${skill.name}". Carry out its steps in order, one or two per turn, under every usual rule:`,
      '- First ask for a value for each variable, showing its default, and wait for the answers.',
      '- For each apify_actor step: call get_actor_input_schema, show the saved input_template values (with variables filled in) as the suggested inputs, and wait for the owner to confirm or change them before run_apify_actor. Budget stays at or under $20.',
      '- Every high-risk step (run_apify_actor, decide_validation, duplicate_campaign, assign_leads, launching) only files an approval. Never say it ran.',
      '- After each step say what happened, what is next and why.',
      `Steps:\n${outline}`,
      `Skill JSON: ${json}`,
    ].join('\n')
  }
  return [
    `The owner attached the saved skill "${skill.name}" as reference only. Use it as context for this request; do not execute its steps unless the owner explicitly asks.`,
    `Steps:\n${outline}`,
    `Skill JSON: ${json}`,
  ].join('\n')
}
