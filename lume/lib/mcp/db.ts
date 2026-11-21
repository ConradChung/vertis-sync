import { createServiceClient } from '@/lib/supabase/service'

/** Service-role client. Server-side only; never returned or logged. */
export const sb = () => createServiceClient()

type Res<T> = { data: T | null; error: { message: string } | null; count?: number | null }

/** Unwraps a Supabase result. The DB message stays in server logs, not the client's view. */
export function must<T>(label: string, res: Res<T>): T {
  if (res.error) throw new Error(`${label}: ${res.error.message}`)
  return (res.data ?? ([] as unknown)) as T
}

export function countOf(label: string, res: Res<unknown>): number {
  if (res.error) throw new Error(`${label}: ${res.error.message}`)
  return res.count ?? 0
}
