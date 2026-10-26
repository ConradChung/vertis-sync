import { describe, expect, it } from 'vitest'
import { SYSTEM_PROMPT } from '@/lib/agent/prompt'

describe('prompt: detailed pipeline diagrams', () => {
  it('asks for per-node details mirroring the playbook stages', () => {
    expect(SYSTEM_PROMPT).toContain('Every node gets a details object')
    for (const field of ['why', 'how', 'tools', 'actors', 'inputs', 'outputs', 'data', 'owner', 'approval', 'cost', 'eta', 'risks', 'decision', 'links'])
      expect(SYSTEM_PROMPT).toMatch(new RegExp(`\\b${field}\\b`))
    expect(SYSTEM_PROMPT).toMatch(/Target & ICP[\s\S]*Review & filter[\s\S]*Apollo export[\s\S]*Validator[\s\S]*Copy[\s\S]*Launch[\s\S]*Monitor/)
    expect(SYSTEM_PROMPT).toContain('never a short generic chain')
    expect(SYSTEM_PROMPT).toContain('at most 40')
    expect(SYSTEM_PROMPT).not.toContain('At most 30 nodes')
  })

  it('stays static (cacheable)', () => {
    expect(SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
  })
})
