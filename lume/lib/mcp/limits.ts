import { createServiceClient } from '@/lib/supabase/service'

export type CallClass = 'read' | 'write' | 'confirm'

/** Per-class budget: `max` calls per `windowMs`, counted across all instances. */
export const LIMITS: Record<CallClass, { max: number; windowMs: number; label: string }> = {
  read: { max: 60, windowMs: 60_000, label: '60 reads per minute' },
  write: { max: 20, windowMs: 60_000, label: '20 writes per minute' },
  confirm: { max: 10, windowMs: 3_600_000, label: '10 confirms per hour' },
}

/** Counts this class's recent audit rows. Injected in tests. */
export type CallCounter = (cls: CallClass, sinceIso: string) => Promise<number>

/**
 * Serverless instances share no memory, so the count comes from the audit
 * rows in `events` (type mcp.tool_call, indexed on type + created_at).
 * Rate-limited calls are excluded so a client that backs off recovers.
 */
export const countFromEvents: CallCounter = async (cls, sinceIso) => {
  const sb = createServiceClient()
  const { count, error } = await sb
    .from('events')
    .select('id', { count: 'exact', head: true })
    .eq('type', 'mcp.tool_call')
    .eq('payload->>class', cls)
    .neq('payload->>outcome', 'rate_limited')
    .gte('created_at', sinceIso)
  if (error) throw new Error('rate limit count failed')
  return count ?? 0
}

export type LimitResult = { ok: true } | { ok: false; message: string }

/** Fails closed: if the count can't be read, the call is refused. */
export async function checkLimit(
  cls: CallClass,
  count: CallCounter = countFromEvents,
  now: Date = new Date(),
): Promise<LimitResult> {
  const { max, windowMs, label } = LIMITS[cls]
  let used: number
  try {
    used = await count(cls, new Date(now.getTime() - windowMs).toISOString())
  } catch {
    return { ok: false, message: 'Rate limit check is unavailable right now. Try again in a minute.' }
  }
  if (used >= max) return { ok: false, message: `Rate limit reached (${label}). Wait and retry.` }
  return { ok: true }
}
