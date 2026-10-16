/**
 * Browser-side JSON calls for the Validate screen. A network failure or a
 * client-side timeout comes back as `{ status: 0, aborted }` instead of
 * throwing, so callers can treat "no answer" as "re-read the gate".
 */
export interface ApiAnswer<T = unknown> {
  status: number
  body: T | null
  aborted?: boolean
}

export async function sendJson<T = unknown>(
  url: string,
  body: unknown,
  { method = 'POST', timeoutMs = 30_000 }: { method?: string; timeoutMs?: number } = {}
): Promise<ApiAnswer<T>> {
  try {
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const json = (await res.json().catch(() => null)) as T | null
    return { status: res.status, body: json }
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    return { status: 0, body: null, aborted: name === 'TimeoutError' || name === 'AbortError' }
  }
}

/** Seconds → "~4 min" / "~45 s" / "~1 h 20 min". */
export function formatEta(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null
  if (seconds < 60) return `~${Math.round(seconds)} s`
  const mins = Math.round(seconds / 60)
  if (mins < 60) return `~${mins} min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m ? `~${h} h ${m} min` : `~${h} h`
}
