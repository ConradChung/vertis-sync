/**
 * SWR fetcher for Lume's own `/api/*` routes. Same-origin, cookie session.
 * Throws an `ApiError` carrying the status so screens can tell a 401 (session
 * gone → the middleware will redirect the next navigation) from a 500.
 */
export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as { error?: string }
      if (body?.error) message = body.error
    } catch {
      // non-JSON error body: keep the status text
    }
    throw new ApiError(res.status, message)
  }
  return (await res.json()) as T
}
