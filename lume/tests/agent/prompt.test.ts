import { describe, expect, it } from 'vitest'
import { SYSTEM_PROMPT } from '@/lib/agent/prompt'

const at = (needle: string) => {
  const i = SYSTEM_PROMPT.indexOf(needle)
  expect(i, `missing: ${needle}`).toBeGreaterThanOrEqual(0)
  return i
}

describe('planning playbook', () => {
  it('walks target → ICP → source → enrichment → validation → copy → setup → assign/launch → after launch', () => {
    const order = [
      '1. Confirm the target.',
      '2. ICP research',
      '3. Lead source.',
      '4. Review, filter, then enrich.',
      '5. Validation.',
      '6. Copy.',
      '7. Campaign setup.',
      '8. Assign leads',
      '9. After launch',
    ].map(at)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('reviews and filters in chat, then a manual Apollo export; no Apollo API', () => {
    expect(at('load_actor_results')).toBeLessThan(at('export_for_apollo'))
    at('filter_leads')
    expect(SYSTEM_PROMPT).toMatch(/only when Conrad asks/)
    expect(SYSTEM_PROMPT).toMatch(/Never send anything to Apollo/)
    expect(SYSTEM_PROMPT).not.toMatch(/enrich_with_apollo/)
  })

  it('never ranks campaigns before a launch exists', () => {
    const rank = at('rank_campaigns')
    expect(rank).toBeGreaterThan(at('9. After launch'))
    expect(SYSTEM_PROMPT).toMatch(/copy settings from/)
    expect(SYSTEM_PROMPT).not.toMatch(/rank_campaigns and recommend a source campaign/)
  })

  it('stays static (no timestamps) so it remains cacheable', () => {
    expect(SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
  })
})

describe('approvals in the chat', () => {
  it('awaiting_approval: one line, the owner decides in the card; no link to open', () => {
    at('awaiting_approval')
    expect(SYSTEM_PROMPT).toMatch(/card right in the chat/)
    expect(SYSTEM_PROMPT).toMatch(/don't tell him to open a link/i)
    expect(SYSTEM_PROMPT).not.toMatch(/give the deep link/)
  })

  it('auto_approved: report the outcome; an uncertain failure is checked, never retried', () => {
    at('auto_approved')
    at('outcome')
    expect(SYSTEM_PROMPT).toMatch(/uncertain/)
    expect(SYSTEM_PROMPT).toMatch(/never retry it yourself/)
  })

  it('[approval] messages are the decision outcome; continue without re-asking', () => {
    at('[approval]')
    expect(SYSTEM_PROMPT).toMatch(/without asking again/)
  })
})
