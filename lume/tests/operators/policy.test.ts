import { describe, expect, it } from 'vitest'
import { canApproveSend, SELF_APPROVAL_ERROR } from '@/lib/operators/policy'

const bot = (id: string, is_master = false) => ({ id, is_master })
const reply = (drafted_by_operator?: string) => ({ kind: 'send_reply', payload: { reply_to_uuid: 'e1', ...(drafted_by_operator ? { drafted_by_operator } : {}) } })

describe('canApproveSend (owner decision 2026-10-29: a bot never approves its own reply)', () => {
  it('the owner may approve any reply', () => {
    expect(canApproveSend(null, reply('op-1'))).toBe(true)
  })
  it('a bot may not approve a reply it drafted (directly, or through Lume\'s agent in a chat it started)', () => {
    expect(canApproveSend(bot('op-1'), reply('op-1'))).toBe(false)
  })
  it('the master bot is held to the same rule for its own drafts', () => {
    expect(canApproveSend(bot('op-m', true), reply('op-m'))).toBe(false)
  })
  it('another bot, or the master, may approve someone else\'s draft', () => {
    expect(canApproveSend(bot('op-2'), reply('op-1'))).toBe(true)
    expect(canApproveSend(bot('op-m', true), reply('op-1'))).toBe(true)
  })
  it('a reply nobody marked as bot-drafted (owner, agent in an owner chat) may be approved by a bot', () => {
    expect(canApproveSend(bot('op-1'), reply())).toBe(true)
  })
  it('only send_reply is governed', () => {
    expect(canApproveSend(bot('op-1'), { kind: 'pause_campaign', payload: { drafted_by_operator: 'op-1' } })).toBe(true)
  })
  it('has a fixed refusal text', () => {
    expect(SELF_APPROVAL_ERROR).toMatch(/drafted/)
  })
})
