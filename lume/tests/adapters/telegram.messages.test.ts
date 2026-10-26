import { beforeEach, describe, expect, it } from 'vitest'
import {
  actionLink,
  buildActionPrompt,
  buildDecisionNote,
  buildGatePing,
  deepLink,
} from '@/lib/adapters/telegram.messages'
import type { PendingActionRow } from '@/lib/db/types'

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e'

function actionRow(over: Partial<PendingActionRow> = {}): PendingActionRow {
  return {
    id: ID,
    kind: 'push_to_instantly',
    payload: { summary: '312 valid → Kaspen SF', job_id: 'j1' },
    risk: 'high',
    status: 'awaiting',
    claim_status: 'awaiting',
    requested_by: 'user',
    agent_run_id: null,
    rule_id: null,
    telegram_message_id: null,
    decided_via: null,
    decided_at: null,
    executed_at: null,
    result: null,
    error: null,
    created_at: '2026-10-14T20:00:00Z',
    updated_at: '2026-10-14T20:00:00Z',
    ...over,
  }
}

describe('links', () => {
  beforeEach(() => {
    process.env.LUME_URL = 'https://lume.example.com/'
  })

  it('deepLink is ${LUME_URL}/validate?gate=<kind>:<id> with the trailing slash stripped', () => {
    expect(deepLink('ingest_approval', ID)).toBe(`https://lume.example.com/validate?gate=ingest_approval:${ID}`)
  })

  it('actionLink is ${LUME_URL}/actions/<id>', () => {
    expect(actionLink(ID)).toBe(`https://lume.example.com/actions/${ID}`)
  })

  it('are null when LUME_URL is unset or blank', () => {
    delete process.env.LUME_URL
    expect(deepLink('stall', ID)).toBeNull()
    expect(actionLink(ID)).toBeNull()
    process.env.LUME_URL = '   '
    expect(deepLink('stall', ID)).toBeNull()
  })
})

describe('buildGatePing', () => {
  beforeEach(() => {
    process.env.LUME_URL = 'https://lume.example.com'
  })

  it('uses the title when given and the kind otherwise', () => {
    expect(buildGatePing('ingest_approval', ID, 'leads.csv').text).toBe(
      `🔗 leads.csv — open in Lume\nhttps://lume.example.com/validate?gate=ingest_approval:${ID}`
    )
    expect(buildGatePing('finder_decision', ID).text).toBe(
      `🔗 finder_decision — open in Lume\nhttps://lume.example.com/validate?gate=finder_decision:${ID}`
    )
    expect(buildGatePing('finder_decision', ID, '   ').text.startsWith('🔗 finder_decision')).toBe(true)
  })

  it('disables the link preview and does not flag linkOmitted', () => {
    const m = buildGatePing('stall', ID)
    expect(m.disablePreview).toBe(true)
    expect(m.linkOmitted).toBeUndefined()
  })

  it('omits the link and flags it when LUME_URL is unset', () => {
    delete process.env.LUME_URL
    const m = buildGatePing('stall', ID, 'leads.csv')
    expect(m.text).toBe('🔗 leads.csv — open in Lume')
    expect(m.text).not.toContain('http')
    expect(m.linkOmitted).toBe(true)
  })
})

describe('buildActionPrompt', () => {
  beforeEach(() => {
    process.env.LUME_URL = 'https://lume.example.com'
  })

  it('carries kind, summary and the deep link in the text', () => {
    const { text, linkOmitted } = buildActionPrompt(actionRow())
    expect(text).toContain('push_to_instantly')
    expect(text).toContain('312 valid → Kaspen SF')
    expect(text).toContain(`https://lume.example.com/actions/${ID}`)
    expect(linkOmitted).toBeUndefined()
  })

  it('falls back to the kind when payload.summary is missing', () => {
    const { text } = buildActionPrompt(actionRow({ payload: {} }))
    expect(text).toContain('push_to_instantly')
  })

  it('has the lume_ok / lume_no inline keyboard', () => {
    const { replyMarkup } = buildActionPrompt(actionRow())
    expect(replyMarkup).toEqual({
      inline_keyboard: [
        [
          { text: '✅ Approve', callback_data: `lume_ok:${ID}` },
          { text: '❌ Reject', callback_data: `lume_no:${ID}` },
        ],
      ],
    })
  })

  it('keeps the keyboard but drops the link when LUME_URL is unset', () => {
    delete process.env.LUME_URL
    const m = buildActionPrompt(actionRow())
    expect(m.text).not.toContain('http')
    expect(m.text).not.toContain('Review in Lume')
    expect(m.text).toContain('312 valid → Kaspen SF')
    expect(m.replyMarkup?.inline_keyboard[0]).toHaveLength(2)
    expect(m.linkOmitted).toBe(true)
  })
})

describe('buildDecisionNote', () => {
  it('names the action and the short id', () => {
    expect(buildDecisionNote('approve', ID)).toBe('🖥 approve on 0f8fad5b — decided in Lume')
  })
})

describe('buildActionPrompt — send_reply shows what will be sent', () => {
  beforeEach(() => {
    process.env.LUME_URL = 'https://lume.example.com'
  })

  it('includes recipient, sender, subject and the full body', () => {
    const body = 'Hi Sam,\n\nTuesday at 3 works. I will send an invite.\n\n— C'
    const m = buildActionPrompt(
      actionRow({
        kind: 'send_reply',
        payload: { summary: 'Send reply to sam@x.com', eaccount: 'me@send.com', reply_to_uuid: 'e1', subject: 'Re: Hi', body, lead_email: 'sam@x.com', recipient_verified: true },
      })
    )
    expect(m.text).toContain('To: sam@x.com\n')
    expect(m.text).toContain('From: me@send.com')
    expect(m.text).toContain('Subject: Re: Hi')
    expect(m.text).toContain(body)
    expect(m.text).not.toContain('unverified')
  })

  it('marks an unlooked-up recipient unverified, and a missing one too', () => {
    const a = buildActionPrompt(actionRow({ kind: 'send_reply', payload: { summary: 's', body: 'x', lead_email: 'boss@corp.com', recipient_verified: false } }))
    expect(a.text).toContain('To: boss@corp.com (unverified)')
    const b = buildActionPrompt(actionRow({ kind: 'send_reply', payload: { summary: 's', body: 'x', recipient_verified: false } }))
    expect(b.text).toContain('To: unverified')
  })

  it('caps the body at 3500 chars and stays under Telegram’s 4096 limit', () => {
    const m = buildActionPrompt(actionRow({ kind: 'send_reply', payload: { summary: 'Send reply', body: 'a'.repeat(10_000), lead_email: 'x@y.z' } }))
    expect(m.text).toContain('a'.repeat(3500) + '… [truncated')
    expect(m.text).not.toContain('a'.repeat(3501))
    expect(m.text.length).toBeLessThan(4096)
  })

  it('other kinds are unchanged (no reply detail)', () => {
    expect(buildActionPrompt(actionRow()).text).not.toContain('To:')
  })
})
