import { describe, expect, it } from 'vitest'
import { knowledgeBlock, snippet, withKnowledge, KNOWLEDGE_MAX_CHARS } from '@/lib/agent/memoryModel'

describe('knowledgeBlock', () => {
  it('is empty with nothing saved', () => {
    expect(knowledgeBlock([], [])).toBe('')
    expect(withKnowledge('', 'hi')).toBe('hi')
  })

  it('lists memories newest-first, then recent chat titles, within budget', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ kind: 'fact' as const, content: `Fact number ${i} about a client offer and its ICP` }))
    const out = knowledgeBlock(many, ['Kaspen pipeline', 'Clay ICP'])
    expect(out.startsWith('What Lume knows')).toBe(true)
    expect(out).toContain('- [fact] Fact number 0 ')
    expect(out).not.toContain('Fact number 79')
    expect(out).toContain('Recent chats: “Kaspen pipeline”, “Clay ICP”')
    expect(out.length).toBeLessThanOrEqual(KNOWLEDGE_MAX_CHARS + 400)
  })

  it('puts knowledge ahead of the prompt', () => {
    expect(withKnowledge('K', 'P')).toBe('K\n\nP')
  })
})

describe('snippet', () => {
  it('centres on the match', () => {
    const text = `${'a '.repeat(200)}Kaspen ICP is property managers${' b'.repeat(200)}`
    const s = snippet(text, 'kaspen icp', 20)
    expect(s).toContain('Kaspen ICP')
    expect(s.startsWith('…')).toBe(true)
    expect(s.endsWith('…')).toBe(true)
  })
})
