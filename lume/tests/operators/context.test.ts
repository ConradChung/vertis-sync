import { describe, expect, it } from 'vitest'
import { operatorChipLabel, operatorPromptLine } from '@/lib/operators/context'

describe('operatorPromptLine', () => {
  it('names a vertical bot, its campaigns and its authority', () => {
    const line = operatorPromptLine({ is_master: false }, { name: 'Roofers', campaign_ids: ['c1', 'c2'] })
    expect(line).toBe('You are being operated by the Roofers Grok Bot (operator). Its campaigns: c1, c2. It has the owner’s full authority.')
    expect(operatorPromptLine({ is_master: false }, { name: 'PM reactions', campaign_ids: [] })).toContain('Its campaigns: none.')
  })
  it('describes the master bot', () => {
    expect(operatorPromptLine({ is_master: true }, null)).toMatch(/operated by the master Grok Bot.*oversees all verticals and can create new ones/)
  })
})

describe('operatorChipLabel', () => {
  it('is Master, the vertical name, or the key label as a fallback', () => {
    expect(operatorChipLabel({ is_master: true, label: 'x' }, null)).toBe('Master')
    expect(operatorChipLabel({ is_master: false, label: 'x' }, { name: 'Roofers' })).toBe('Roofers')
    expect(operatorChipLabel({ is_master: false, label: 'bot' }, null)).toBe('bot')
  })
})
