/**
 * Validate screen keyboard: J/K move between gate cards, A = first
 * approve-like action, R = reject-like, E = open the row editor. Pure.
 */

export type KeyIntent = 'next' | 'prev' | 'approve' | 'reject' | 'edit'

export interface KeyInput {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  repeat?: boolean
  /** `event.target.tagName`. */
  targetTag?: string
  /** `event.target.isContentEditable`. */
  targetEditable?: boolean
}

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])
const MAP: Record<string, KeyIntent> = { j: 'next', k: 'prev', a: 'approve', r: 'reject', e: 'edit' }

export function keyIntent(e: KeyInput): KeyIntent | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null
  if (e.targetEditable) return null
  if (e.targetTag && TYPING_TAGS.has(e.targetTag.toUpperCase())) return null
  const intent = MAP[e.key.length === 1 ? e.key.toLowerCase() : ''] ?? null
  // A held key must not fire a decision twice.
  if (e.repeat && intent !== 'next' && intent !== 'prev') return null
  return intent
}

/** Roving focus index after `next`/`prev`, clamped; -1 for an empty list. */
export function moveFocus(index: number, count: number, intent: 'next' | 'prev'): number {
  if (count <= 0) return -1
  if (index < 0) return 0
  const next = intent === 'next' ? index + 1 : index - 1
  return Math.min(Math.max(next, 0), count - 1)
}
