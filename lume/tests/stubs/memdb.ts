// A tiny in-memory stand-in for the Supabase query builder: enough of
// from(t).select/insert/upsert/update/delete + eq/neq/is/in/order/limit +
// maybeSingle/single for store modules (lib/slack/store.ts) to run for real
// against table arrays. Unique keys are given per table for upserts.
//   const db = memdb({ lume_slack_installs: ['team_id'], lume_slack_channels: ['team_id', 'channel_id'] })
//   vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => db.client }))
type Row = Record<string, unknown>

export function memdb(uniques: Record<string, string[]>) {
  const tables: Record<string, Row[]> = {}
  let nextId = 1
  const table = (t: string) => (tables[t] ??= [])

  function from(t: string) {
    let op: 'select' | 'upsert' | 'update' | 'delete' = 'select'
    let payload: Row | Row[] | null = null
    let opts: { onConflict?: string; ignoreDuplicates?: boolean } = {}
    const filters: ((r: Row) => boolean)[] = []
    let limit = Infinity
    let single: 'one' | 'maybe' | null = null

    const run = (): { data: unknown; error: null | { message: string; code?: string } } => {
      const rows = table(t)
      let out: Row[] = []
      if (op === 'select') out = rows.filter((r) => filters.every((f) => f(r)))
      else if (op === 'update') {
        out = rows.filter((r) => filters.every((f) => f(r)))
        for (const r of out) Object.assign(r, payload)
      } else if (op === 'delete') {
        out = rows.filter((r) => filters.every((f) => f(r)))
        tables[t] = rows.filter((r) => !out.includes(r))
      } else {
        const keys = opts.onConflict ? opts.onConflict.split(',') : (uniques[t] ?? ['id'])
        for (const p of Array.isArray(payload) ? payload : [payload!]) {
          const hit = rows.find((r) => keys.every((k) => r[k] === p[k]))
          if (hit) {
            if (opts.ignoreDuplicates) continue
            Object.assign(hit, p)
            out.push(hit)
          } else {
            const row = { id: p.id ?? (t === 'lume_slack_channels' ? `00000000-0000-0000-0000-${String(nextId).padStart(12, '0')}` : nextId), ...p }
            nextId++
            rows.push(row)
            out.push(row)
          }
        }
      }
      out = out.slice(0, limit).map((r) => ({ ...r }))
      if (single === 'one') return out.length === 1 ? { data: out[0], error: null } : { data: null, error: { message: 'not one row', code: 'PGRST116' } }
      if (single === 'maybe') return { data: out[0] ?? null, error: null }
      return { data: out, error: null }
    }

    const b: Record<string, unknown> = {
      select: () => b,
      upsert: (p: Row | Row[], o: typeof opts = {}) => ((op = 'upsert'), (payload = p), (opts = o), b),
      insert: (p: Row | Row[]) => ((op = 'upsert'), (payload = p), b),
      update: (p: Row) => ((op = 'update'), (payload = p), b),
      delete: () => ((op = 'delete'), b),
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
      neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), b),
      is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b),
      in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), b),
      order: () => b,
      limit: (n: number) => ((limit = n), b),
      maybeSingle: () => ((single = 'maybe'), b),
      single: () => ((single = 'one'), b),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve().then(run).then(resolve, reject),
    }
    return b
  }

  return { tables, table, client: { from } }
}
