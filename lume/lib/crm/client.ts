import type { CrmPatchResult } from '@/lib/crm/types'

/** Browser calls for the CRM routes. */

export type PatchBody = {
  stage?: string
  reason?: string
  owner?: string | null
  next_action?: string | null
  next_action_at?: string | null
  notes?: string | null
}

export type PatchAnswer = { status: number; body: (CrmPatchResult & { error?: undefined }) | { ok?: false; error: string } | null }

export async function patchDeal(id: string, body: PatchBody): Promise<PatchAnswer> {
  try {
    const res = await fetch(`/api/crm/deals/${id}`, {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    })
    let parsed: PatchAnswer['body'] = null
    try {
      parsed = await res.json()
    } catch {
      parsed = null
    }
    return { status: res.status, body: parsed }
  } catch {
    return { status: 0, body: { error: 'network' } }
  }
}

export function patchErrorText(a: PatchAnswer): string {
  const e = a.body && 'error' in a.body ? a.body.error : null
  switch (e) {
    case 'close_awaiting':
      return 'A Won/Lost confirmation for this deal is already waiting for approval.'
    case 'reason_required':
      return 'Add a one-line reason.'
    case 'unknown_stage':
      return 'That stage does not exist for this campaign.'
    case 'not_found':
      return 'This deal no longer exists.'
    case 'network':
      return 'Network error — try again.'
    default:
      return a.status === 401 ? 'Session expired — reload.' : 'Could not save. Try again.'
  }
}

/** Instantly unibox for the lead, or a Gmail compose to them. Opening a link sends nothing. */
export function replyHref(source: string, email: string): string {
  if (source === 'gmail') return `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(email)}`
  return `https://app.instantly.ai/app/unibox?search=${encodeURIComponent(email)}`
}

export function initials(name: string | null, email: string): string {
  const src = (name ?? '').trim() || email.split('@')[0]
  const parts = src.split(/[\s._-]+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase()
}

export function relShort(iso: string | null, now = Date.now()): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '—'
  const s = Math.round((now - t) / 1000)
  const a = Math.abs(s)
  const v = a < 60 ? 'now' : a < 3600 ? `${Math.floor(a / 60)}m` : a < 86_400 ? `${Math.floor(a / 3600)}h` : `${Math.floor(a / 86_400)}d`
  if (v === 'now') return 'now'
  return s >= 0 ? `${v} ago` : `in ${v}`
}
