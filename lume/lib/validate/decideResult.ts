import type { DecideResult } from '@/lib/adapters/pipeline'

/**
 * Entrypoint result → HTTP for `POST /api/gates/decide`, and the client's
 * reading of that response. Pure.
 *
 * A timeout is never a failure: the handler may still be running (an approve
 * of a large CSV takes 60–100 s), so the route answers 202 and the screen
 * re-reads the gate.
 */

export type DecideHttp =
  | { status: 200; body: { ok: true; claimed: boolean | null } }
  | { status: 202; body: { pending: true } }
  | { status: 400 | 409 | 502 | 503; body: { error: string } }

export function decideHttp(r: DecideResult): DecideHttp {
  if (r.ok) {
    if (r.claimed === false) return { status: 409, body: { error: 'already_handled' } }
    return { status: 200, body: { ok: true, claimed: r.claimed } }
  }
  if (r.error === 'timeout') return { status: 202, body: { pending: true } }
  if (r.status === 400) return { status: 400, body: { error: 'bad_callback_data' } }
  if (r.status === 0 && r.error === 'pipeline entrypoint not configured') {
    return { status: 503, body: { error: 'pipeline_not_configured' } }
  }
  return { status: 502, body: { error: 'pipeline_error' } }
}

export type DecideOutcome = 'done' | 'sent' | 'already_handled' | 'pending' | 'error'

/**
 * `done`: the gate closed. `sent`: accepted but not observable (camp_launch,
 * jobs_abort, push_cancel… — the handler reports in Telegram). `pending`:
 * still working (202, or a gateway timeout) — re-read.
 */
export function clientOutcome(status: number, body: unknown): DecideOutcome {
  const b = (body ?? {}) as { claimed?: unknown }
  if (status === 200) return b.claimed === true ? 'done' : 'sent'
  if (status === 409) return 'already_handled'
  if (status === 202 || status === 504) return 'pending'
  return 'error'
}
