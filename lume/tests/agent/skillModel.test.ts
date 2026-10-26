import { describe, expect, it } from 'vitest'
import { describeStep, newSkillSchema, placeholdersIn, skillContext, skillPatchSchema, skillStepSchema, type Skill } from '@/lib/agent/skillModel'

const ROOFERS: Skill = {
  id: '11111111-2222-4333-8444-555555555555',
  name: 'Roofers in a city',
  description: 'Google Maps roofers → validate → copy best campaign → launch',
  variables: [
    { name: 'city', description: 'Target city', default: 'Austin, TX' },
    { name: 'industry', description: 'Search term', default: 'roofing contractor' },
  ],
  steps: [
    { type: 'apify_actor', actor_id: 'compass/crawler-google-places', actor_name: 'Google Maps Scraper', input_template: { searchStringsArray: ['{{industry}}'], locationQuery: '{{city}}' }, budget_usd: 15 },
    { type: 'import' },
    { type: 'validate' },
    { type: 'duplicate_campaign', source_campaign_id: 'abc', source_campaign_name: 'Scaleport - Fall Mega', name_template: 'Roofers {{city}}' },
    { type: 'assign_leads', count: 500 },
    { type: 'launch' },
  ],
  source_conversation_id: null,
  created_at: '2026-10-26T00:00:00Z',
  updated_at: '2026-10-26T00:00:00Z',
  last_run_at: null,
  run_count: 0,
}

describe('skill step validation', () => {
  it('accepts every step type', () => {
    for (const step of [
      ...ROOFERS.steps,
      { type: 'rotation_rule', rule: { name: 'Daily 50', cron: '0 9 * * *' } },
      { type: 'note', text: 'Check bounce rate first' },
    ]) expect(skillStepSchema.safeParse(step).success).toBe(true)
  })

  it('rejects unknown types, unknown keys, over-cap budgets and missing fields', () => {
    expect(skillStepSchema.safeParse({ type: 'send_email' }).success).toBe(false)
    expect(skillStepSchema.safeParse({ type: 'launch', extra: 1 }).success).toBe(false)
    expect(skillStepSchema.safeParse({ type: 'apify_actor', actor_id: 'x', budget_usd: 25 }).success).toBe(false)
    expect(skillStepSchema.safeParse({ type: 'apify_actor' }).success).toBe(false)
    expect(skillStepSchema.safeParse({ type: 'duplicate_campaign', source_campaign_id: 'a' }).success).toBe(false)
    expect(skillStepSchema.safeParse({ type: 'note', text: '' }).success).toBe(false)
  })

  it('caps an input template at 20 kB', () => {
    const big = { type: 'apify_actor', actor_id: 'x', input_template: { blob: 'a'.repeat(21_000) } }
    expect(skillStepSchema.safeParse(big).success).toBe(false)
  })

  it('a new skill needs a name and 1-30 steps, with unique lowercase variable names', () => {
    const base = { name: ' Roofers ', steps: [{ type: 'launch' }] }
    const ok = newSkillSchema.parse(base)
    expect(ok).toMatchObject({ name: 'Roofers', description: '', variables: [] })
    expect(newSkillSchema.safeParse({ ...base, steps: [] }).success).toBe(false)
    expect(newSkillSchema.safeParse({ ...base, name: '' }).success).toBe(false)
    expect(newSkillSchema.safeParse({ ...base, variables: [{ name: 'City' }] }).success).toBe(false)
    expect(newSkillSchema.safeParse({ ...base, variables: [{ name: 'city' }, { name: 'city' }] }).success).toBe(false)
  })

  it('a patch needs name or description', () => {
    expect(skillPatchSchema.safeParse({}).success).toBe(false)
    expect(skillPatchSchema.safeParse({ name: 'New' }).success).toBe(true)
    expect(skillPatchSchema.safeParse({ steps: [] }).success).toBe(false)
  })
})

describe('describeStep / placeholdersIn', () => {
  it('labels steps in plain words', () => {
    expect(ROOFERS.steps.map(describeStep)).toEqual([
      'Run Apify actor: Google Maps Scraper (≤ $15)',
      'Import results',
      'Validate',
      'Duplicate campaign: Scaleport - Fall Mega → "Roofers {{city}}"',
      'Assign leads: 500',
      'Launch',
    ])
  })

  it('finds the {{variables}} used in steps', () => {
    expect(placeholdersIn(ROOFERS.steps).sort()).toEqual(['city', 'industry'])
  })
})

describe('skillContext', () => {
  it('run mode tells the agent to execute, ask for variables and actor inputs, and file approvals', () => {
    const text = skillContext(ROOFERS, 'run')
    expect(text).toContain('RUN the saved skill "Roofers in a city"')
    expect(text).toMatch(/ask for a value for each variable/i)
    expect(text).toContain('get_actor_input_schema')
    expect(text).toMatch(/only files an approval/)
    expect(text).toContain('1. Run Apify actor: Google Maps Scraper')
    expect(text).toContain('"locationQuery":"{{city}}"')
  })

  it('reference mode is context only', () => {
    const text = skillContext(ROOFERS, 'reference')
    expect(text).toContain('reference only')
    expect(text).toMatch(/do not execute its steps/)
    expect(text).not.toContain('RUN the saved skill')
  })
})
