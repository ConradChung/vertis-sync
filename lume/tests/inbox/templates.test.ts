import { describe, expect, it } from 'vitest'
import { INBOX_NOTE_NAMES, INBOX_NOTE_TEMPLATES, inboxProjectName, notesToSeed } from '@/lib/inbox/templates'
import { NOTE_MAX } from '@/lib/agent/projectModel'

describe('Inbox project templates', () => {
  it('names the project "<vertical> · Inbox"', () => {
    expect(inboxProjectName('Roofers')).toBe('Roofers · Inbox')
    expect(inboxProjectName('  Kaspen / Zenport ')).toBe('Kaspen / Zenport · Inbox')
  })

  it('caps the name at the project name limit', () => {
    expect(inboxProjectName('x'.repeat(80)).length).toBeLessThanOrEqual(80)
    expect(inboxProjectName('x'.repeat(80)).endsWith(' · Inbox')).toBe(true)
  })

  it('seeds the five SOP files, in order', () => {
    expect(INBOX_NOTE_NAMES).toEqual(['qualify-rules.md', 'voice-samples.md', 'voice-rules.md', 'reply-templates.md', 'settings.md'])
  })

  it('every note fits a project note', () => {
    for (const t of INBOX_NOTE_TEMPLATES) {
      expect(t.content.trim().length).toBeGreaterThan(0)
      expect(t.content.length).toBeLessThanOrEqual(NOTE_MAX)
    }
  })

  const text = (name: string) => INBOX_NOTE_TEMPLATES.find((t) => t.name === name)!.content

  it('qualify-rules has fit criteria, the UNSURE rule, the skip list and the skip log format', () => {
    const q = text('qualify-rules.md')
    expect(q).toContain('{{fit criteria}}')
    expect(q).toContain('{{UNSURE rule}}')
    expect(q).toMatch(/Anyone who asked to be removed or was hostile/)
    expect(q).toMatch(/Competitors/)
    expect(q).toContain('{{date}} | {{company}} | {{domain}} | BAD | one-sentence reason | blocked: yes/no')
  })

  it('voice-rules starts empty apart from its header', () => {
    const v = text('voice-rules.md')
    const body = v.split('\n').filter((l) => l.trim() && !l.startsWith('#') && !l.startsWith('>'))
    expect(body).toEqual([])
  })

  it('reply-templates has the SOP §6.3 shapes', () => {
    const r = text('reply-templates.md')
    for (const h of ['Interested / question / more info', 'Named a time / booking confirmation', 'Not now', 'Referral', 'Wrong person', 'Reschedule', 'Follow-up']) {
      expect(r).toContain(h)
    }
    expect(r).toContain('{{greeting}} {{first name}},')
    expect(r).toContain('{{their question}} -> {{answer}}')
  })

  it('settings has every setting the SOP lists for it', () => {
    const s = text('settings.md')
    for (const p of ['{{offer}}', '{{meeting length}}', '{{time offer rule}}', '{{follow-up plan}}', '{{after follow-ups}}', '{{home time zone}}', '{{optional link}}']) {
      expect(s).toContain(p)
    }
    expect(s).toMatch(/[Tt]imes never to offer/)
  })

  it('notesToSeed skips any name already present (case-insensitive) and never overwrites', () => {
    const out = notesToSeed([{ name: 'Voice-Rules.md' }, { name: 'settings.md' }, { name: 'other.md' }])
    expect(out.map((t) => t.name)).toEqual(['qualify-rules.md', 'voice-samples.md', 'reply-templates.md'])
    expect(notesToSeed(INBOX_NOTE_TEMPLATES)).toEqual([])
  })
})
