import 'server-only'
import { createHash } from 'node:crypto'
import { INSTANTLY_BASE_URL, InstantlyError } from '@/lib/adapters/instantly'
import { canonicalSteps, readInstantlySteps, type InstantlyStep } from '@/lib/campaigns/sequence'

/**
 * Instantly v2 sequence read (fresh, uncached) and write. The editor and the
 * `update_sequence` builder read through `getSequenceFresh` so the stale-edit
 * hash is never computed from a cached copy. `patchSequence` changes what a
 * live campaign emails: only `lib/actions/execute.ts` may call it, after the
 * owner approved the `update_sequence` action.
 */

async function call(method: 'GET' | 'PATCH', path: string, body?: unknown): Promise<unknown> {
  const key = process.env.INSTANTLY_API_KEY?.trim()
  if (!key) throw new InstantlyError(0, 'INSTANTLY_API_KEY is not configured')
  let res: Response
  try {
    res = await fetch(`${INSTANTLY_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    })
  } catch (err) {
    throw new InstantlyError(0, `Instantly ${path} unreachable: ${err instanceof Error ? err.message : String(err)}`)
  }
  const text = await res.text().catch(() => '')
  if (!res.ok) throw new InstantlyError(res.status, `Instantly ${method} ${path} failed (${res.status}): ${text.slice(0, 200)}`)
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    return {}
  }
}

/** sha256 (hex, 32 chars) of the canonical steps: the stale-edit check. */
export function hashSteps(steps: InstantlyStep[]): string {
  return createHash('sha256').update(canonicalSteps(steps)).digest('hex').slice(0, 32)
}

export interface FreshSequence {
  name: string | null
  status: number | null
  steps: InstantlyStep[]
  hash: string
}

export async function getSequenceFresh(campaignId: string): Promise<FreshSequence> {
  const body = (await call('GET', `/campaigns/${encodeURIComponent(campaignId)}`)) as Record<string, unknown>
  const steps = readInstantlySteps(body)
  return {
    name: typeof body?.name === 'string' ? body.name : null,
    status: typeof body?.status === 'number' ? body.status : null,
    steps,
    hash: hashSteps(steps),
  }
}

/** `PATCH /campaigns/{id}` with `sequences: [{ steps }]` (Instantly uses only the first sequence). */
export async function patchSequence(campaignId: string, steps: InstantlyStep[]): Promise<unknown> {
  return call('PATCH', `/campaigns/${encodeURIComponent(campaignId)}`, { sequences: [{ steps }] })
}
