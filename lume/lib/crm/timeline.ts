import type { CrmActivity } from '@/lib/crm/types'
import type { Json } from '@/lib/db/types'

/** Timeline / thread text for an activity (pure, client-safe). */

function text(p: Record<string, Json> | null | undefined): string | null {
  if (!p) return null
  for (const k of ['text', 'reply_text', 'reply_text_snippet', 'body', 'snippet', 'content_preview']) {
    const v = p[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

export function replyTextOf(a: CrmActivity): string | null {
  return text(a.payload)
}

export function timelineLabel(a: CrmActivity): string {
  const p = a.payload ?? {}
  switch (a.kind) {
    case 'stage_changed': {
      const from = typeof p.from === 'string' ? p.from : null
      const to = typeof p.to === 'string' ? p.to : '?'
      const why = typeof p.reason === 'string' ? ` — ${p.reason}` : ''
      if (p.backfill) return `Imported at ${to}`
      return `${from ? `${from} → ` : 'Moved to '}${to}${p.auto ? ' (auto)' : ''}${why}`
    }
    case 'sent':
      return typeof p.subject === 'string' && p.subject ? `Sent “${p.subject}”` : 'Email sent'
    case 'opened':
      return 'Opened'
    case 'replied': {
      const t = text(p)
      return t ? `Replied: “${t.replace(/\s+/g, ' ').slice(0, 90)}${t.length > 90 ? '…' : ''}”` : 'Replied'
    }
    case 'bounced':
      return 'Bounced'
    case 'note':
      return typeof p.text === 'string' ? `Note: ${p.text.slice(0, 120)}` : 'Note'
    case 'meeting':
      return 'Meeting booked'
  }
}
