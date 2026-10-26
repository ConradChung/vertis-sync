'use client'

import Link from 'next/link'
import { Clock3, TriangleAlert } from 'lucide-react'

export type NoticeState =
  | { kind: 'created'; id: string; summary: string }
  | { kind: 'duplicate'; existingId: string | null }
  | { kind: 'error'; message: string }

/** "Awaiting confirmation — also sent to Telegram" after a pending action is created. */
export function ActionNotice({ state, onDismiss }: { state: NoticeState; onDismiss?: () => void }) {
  if (state.kind === 'error') {
    return (
      <div role="alert" className="flex items-start gap-2 rounded-lg border border-red/30 bg-red/10 px-3 py-2 text-[12px] text-fg">
        <TriangleAlert className="mt-px size-3.5 shrink-0 text-red" />
        <span className="flex-1">Couldn&apos;t create the request: {state.message}</span>
        {onDismiss && (
          <button type="button" onClick={onDismiss} className="text-fg-46 hover:text-fg">
            Dismiss
          </button>
        )}
      </div>
    )
  }
  const id = state.kind === 'created' ? state.id : state.existingId
  return (
    <div role="status" className="flex items-start gap-2 rounded-lg border border-violet/30 bg-violet/10 px-3 py-2 text-[12px] text-fg">
      <Clock3 className="mt-px size-3.5 shrink-0 text-violet-soft" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {state.kind === 'created' ? 'Awaiting confirmation — also sent to Telegram' : 'Already awaiting confirmation'}
        </p>
        {state.kind === 'created' && <p className="mt-0.5 truncate text-fg-46">{state.summary}</p>}
      </div>
      {id && (
        <Link href={`/actions/${id}`} className="shrink-0 text-violet-soft hover:text-fg">
          Review →
        </Link>
      )}
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="shrink-0 text-fg-46 hover:text-fg" aria-label="Dismiss">
          ×
        </button>
      )}
    </div>
  )
}

/** Map a `requestCampaignAction` result to a notice. */
export function noticeFrom(
  r: { ok: true; action: { id: string; summary: string } } | { ok: false; error: string; existingId?: string | null }
): NoticeState {
  if (r.ok) return { kind: 'created', id: r.action.id, summary: r.action.summary }
  if (r.error === 'duplicate') return { kind: 'duplicate', existingId: r.existingId ?? null }
  return { kind: 'error', message: r.error }
}
