import { NextResponse } from 'next/server'
import { InstantlyError } from '@/lib/adapters/instantly'

/** `200 { configured: false }` — every Instantly route's answer when the key is unset. */
export const notConfigured = () => NextResponse.json({ configured: false } as const)

/** Upstream failure → 502 with a generic code; detail goes to the server log. */
export function instantlyErrorResponse(err: unknown, where: string): NextResponse {
  const status = err instanceof InstantlyError ? err.status : undefined
  console.error(`[${where}]`, err instanceof Error ? err.message : err)
  return NextResponse.json({ configured: true, error: 'instantly_unreachable', upstream_status: status ?? null }, { status: 502 })
}
