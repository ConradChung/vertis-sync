import { describe, expect, it } from 'vitest'
import { attachmentsOf, contextFromMessages, groupConversations, titleFromPrompt, titleFromMessage } from '@/lib/agent/history'

describe('titleFromPrompt', () => {
  it('uses the first line, collapsed', () => {
    expect(titleFromPrompt('  What is   waiting\non me?')).toBe('What is waiting')
    expect(titleFromPrompt('   ')).toBe('New chat')
  })

  it('cuts long prompts at a word, near 60 chars, with an ellipsis', () => {
    const t = titleFromPrompt('Summarize campaign performance this week and flag anything that looks off compared to last week')
    expect(t.length).toBeLessThanOrEqual(60)
    expect(t.endsWith('…')).toBe(true)
    expect(t).toBe('Summarize campaign performance this week and flag anything…')
  })

  it('hard-cuts a single long word', () => {
    expect(titleFromPrompt('x'.repeat(100))).toBe(`${'x'.repeat(59)}…`)
  })
})

describe('groupConversations', () => {
  const now = new Date(2026, 9, 25, 15, 0)
  const at = (d: number, h = 9) => ({ id: `${d}-${h}`, updated_at: new Date(2026, 9, d, h).toISOString() })

  it('buckets Today / Yesterday / Previous 7 days / Older in order, dropping empty groups', () => {
    const groups = groupConversations([at(25, 14), at(25, 0), at(24, 23), at(20), at(18), at(1)], now)
    expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ['Today', ['25-14', '25-0']],
      ['Yesterday', ['24-23']],
      ['Previous 7 days', ['20-9', '18-9']],
      ['Older', ['1-9']],
    ])
    expect(groupConversations([at(1)], now).map((g) => g.label)).toEqual(['Older'])
    expect(groupConversations([], now)).toEqual([])
  })
})

describe('contextFromMessages', () => {
  it('keeps user turns and assistant turns with text', () => {
    expect(
      contextFromMessages([
        { role: 'user', text: 'a' },
        { role: 'assistant', text: '' },
        { role: 'assistant', text: 'b' },
      ])
    ).toEqual([
      { role: 'user', text: 'a' },
      { role: 'assistant', text: 'b' },
    ])
  })
})

describe('images in history', () => {
  const good = { path: '0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c.png', name: 'shot.png', media_type: 'image/png' as const }
  it('carries a user turn\'s attachments as its images, including an image-only turn', () => {
    expect(contextFromMessages([{ role: 'user', text: '', attachments: [good] }, { role: 'assistant', text: 'ok' }])).toEqual([
      { role: 'user', text: '', images: [good] },
      { role: 'assistant', text: 'ok' },
    ])
  })
  it('attachmentsOf drops malformed stored entries', () => {
    expect(attachmentsOf(null)).toEqual([])
    expect(
      attachmentsOf([good, { path: '../etc/passwd', name: 'x', media_type: 'image/png' }, { path: good.path, name: 'y', media_type: 'image/svg+xml' }, 'junk'])
    ).toEqual([good])
  })
  it('titles an image-only first message after its image', () => {
    expect(titleFromMessage('fix this', [good])).toBe('fix this')
    expect(titleFromMessage('', [good])).toBe('Image: shot.png')
    expect(titleFromMessage('  ', [good, good])).toBe('Image: shot.png +1')
  })
  const file = { kind: 'file' as const, id: '0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0d', name: 'leads.xlsx', file_kind: 'xlsx' as const, size_bytes: 9, sheets: [{ name: 'A', rows: 1, cols: 1 }] }
  it('splits mixed attachments into images and files; a file-only turn is titled after the file', () => {
    expect(contextFromMessages([{ role: 'user', text: 'x', attachments: [good, file] }])).toEqual([{ role: 'user', text: 'x', images: [good], files: [file] }])
    expect(attachmentsOf([good, file])).toEqual([good])
    expect(titleFromMessage('', [], [file])).toBe('File: leads.xlsx')
    expect(titleFromMessage('', [good], [file])).toBe('File: leads.xlsx +1')
  })
})
