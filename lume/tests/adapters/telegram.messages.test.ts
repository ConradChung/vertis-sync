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

  it('disables the link preview', () => {
    expect(buildGatePing('stall', ID).disablePreview).toBe(true)
  })
})

describe('buildActionPrompt', () => {
  beforeEach(() => {
    process.env.LUME_URL = 'https://lume.example.com'
  })

  it('carries kind, summary and the deep link in the text', () => {
    const { text } = buildActionPrompt(actionRow())
    expect(text).toContain('push_to_instantly')
    expect(text).toContain('312 valid → Kaspen SF')
    expect(text).toContain(`https://lume.example.com/actions/${ID}`)
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
})

describe('buildDecisionNote', () => {
  it('names the action and the short id', () => {
    expect(buildDecisionNote('approve', ID)).toBe('🖥 approve on 0f8fad5b — decided in Lume')
  })
})
