// GTM-14: a small Apify client (patterns copied from influencer-reactions,
// whose helpers aren't importable). The fetch is injectable for tests.
import { type Cycle, parseUsageCycle } from './caps.ts'

export const APIFY = 'https://api.apify.com/v2'
export const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'])

export interface RunData {
  id?: string
  status?: string
  statusMessage?: string
  defaultDatasetId?: string
  usageTotalUsd?: number
}

export interface ApifyClient {
  /** Account usage this cycle and the cycle itself; null when unreadable. */
  usage(): Promise<{ cycle: Cycle; usageUsd: number } | null>
  /** Start an actor run; `waitForFinish` seconds (≤ 60) of synchronous waiting. */
  start(actor: string, input: Record<string, unknown>, maxTotalChargeUsd: number, waitForFinish: number): Promise<
    { ok: true; run: RunData } | { ok: false; status: number; error: string; unknown?: boolean }
  >
  run(runId: string): Promise<RunData>
  items(datasetId: string): Promise<unknown[]>
}

export function apifyClient(token: string, f: typeof fetch = fetch): ApifyClient {
  const call = (path: string, init: RequestInit = {}, timeoutMs = 20_000) =>
    f(`${APIFY}${path}`, {
      ...init,
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    })
  return {
    async usage() {
      try {
        const res = await call('/users/me/usage/monthly')
        if (!res.ok) {
          await res.body?.cancel()
          return null
        }
        return parseUsageCycle(await res.json())
      } catch {
        return null
      }
    },
    async start(actor, input, max, wait) {
      const w = Math.max(0, Math.min(60, Math.floor(wait)))
      let res: Response
      try {
        res = await call(`/acts/${actor}/runs?maxTotalChargeUsd=${max}&waitForFinish=${w}`, { method: 'POST', body: JSON.stringify(input) }, (w + 20) * 1000)
      } catch (err) {
        return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err), unknown: true }
      }
      const body = await res.json().catch(() => null) as { data?: RunData; error?: { message?: string } } | null
      if (!res.ok) return { ok: false, status: res.status, error: body?.error?.message ?? `HTTP ${res.status}` }
      if (!body?.data?.id) return { ok: false, status: res.status, error: 'no run id', unknown: true }
      return { ok: true, run: body.data }
    },
    async run(id) {
      const res = await call(`/actor-runs/${encodeURIComponent(id)}`)
      if (!res.ok) throw new Error(`Apify run read failed (${res.status})`)
      return ((await res.json()) as { data?: RunData }).data ?? {}
    },
    async items(datasetId) {
      const out: unknown[] = []
      for (let offset = 0; offset < 10_000; offset += 1_000) {
        const res = await call(`/datasets/${encodeURIComponent(datasetId)}/items?clean=true&format=json&limit=1000&offset=${offset}`, {}, 40_000)
        if (!res.ok) throw new Error(`Apify dataset read failed (${res.status})`)
        const page = await res.json() as unknown[]
        if (!Array.isArray(page)) break
        out.push(...page)
        if (page.length < 1_000) break
      }
      return out
    },
  }
}

const r4 = (n: number) => Math.round(n * 10_000) / 10_000

/** What a finished run cost: max(usageTotalUsd, items × unit price). */
export function actualUsd(run: RunData, items: number, itemUsd: number): number {
  const u = typeof run.usageTotalUsd === 'number' && Number.isFinite(run.usageTotalUsd) && run.usageTotalUsd >= 0 ? run.usageTotalUsd : 0
  return r4(Math.max(u, Math.max(0, items) * itemUsd))
}

/** A failed run settles at its usageTotalUsd (or is released when Apify reports none). */
export function failedUsd(run: RunData): number | null {
  return typeof run.usageTotalUsd === 'number' && Number.isFinite(run.usageTotalUsd) && run.usageTotalUsd > 0 ? r4(run.usageTotalUsd) : null
}
