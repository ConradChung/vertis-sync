import { z } from 'zod'

/**
 * Group-by summaries over a lead set's or list's own columns (pure shapes;
 * the work is the lume_summarize_lead_set RPC, in SQL over the stored cells).
 */

export const METRIC_OPS = ['count_distinct', 'sum', 'avg', 'min', 'max'] as const
export const Metric = z.object({ op: z.enum(METRIC_OPS), column: z.string().min(1).max(200) })
export type Metric = z.infer<typeof Metric>

export const SummaryInput = z.object({
  set_id: z.string().uuid(),
  group_by: z.array(z.string().min(1).max(200)).max(5).optional(),
  metrics: z.array(Metric).max(10).optional(),
  status: z.enum(['kept', 'excluded', 'all']).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  /** Equality filters, e.g. { type: 'post' } (≤ 5). */
  where: z.record(z.string().min(1).max(200), z.string().max(500)).refine((w) => Object.keys(w).length <= 5, 'at most 5').optional(),
  /** The agent's chat and project (a review set is only summarised from its own chat or project). */
  conversation_id: z.string().uuid().nullable().optional(),
  project_id: z.string().uuid().nullable().optional(),
})
export type SummaryInput = z.infer<typeof SummaryInput>

export const metricLabel = (m: Metric) => `${m.op}(${m.column})`

export interface Summary {
  total_rows: number
  group_count: number
  groups: Record<string, string | number | null>[]
  other: { groups: number; rows: number }
}

/** The RPC's g1… / n / m1… back under the column names and op(column) labels. */
export function shapeSummary(raw: { group_count: number; total_rows: number; groups: Record<string, unknown>[]; other: { groups: number; rows: number } }, groupBy: readonly string[], metrics: readonly Metric[]): Summary {
  return {
    total_rows: Number(raw.total_rows) || 0,
    group_count: Number(raw.group_count) || 0,
    groups: raw.groups.map((g) => {
      const out: Record<string, string | number | null> = {}
      groupBy.forEach((c, i) => (out[c] = (g[`g${i + 1}`] as string | null) ?? null))
      out.count = Number(g.n) || 0
      metrics.forEach((m, i) => (out[metricLabel(m)] = g[`m${i + 1}`] === null || g[`m${i + 1}`] === undefined ? null : Number(g[`m${i + 1}`])))
      return out
    }),
    other: { groups: Number(raw.other?.groups) || 0, rows: Number(raw.other?.rows) || 0 },
  }
}
