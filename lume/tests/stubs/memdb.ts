// A tiny in-memory stand-in for the Supabase query builder: enough of
// from(t).select/insert/upsert/update/delete + eq/neq/is/in/order/limit +
// maybeSingle/single for store modules (lib/slack/store.ts) to run for real
// against table arrays. Unique keys are given per table for upserts.
//   const db = memdb({ lume_slack_installs: ['team_id'], lume_slack_channels: ['team_id', 'channel_id'] })
//   vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => db.client }))
// Also: range(), order(col, { ascending }) on plain or `col->>key` paths,
// select(cols, { count: 'exact', head }) counts, not(col, 'is', null),
// ilike(col, '%x%'), and or('a.ilike.%x%,b->>c.ilike.%x%') of ilike terms.
type Row = Record<string, unknown>

/** A column or a `col->>key` JSON path. */
const at = (r: Row, c: string): unknown => {
  const m = /^(\w+)->>(\w+)$/.exec(c)
  if (!m) return r[c]
  const o = r[m[1]] as Row | null | undefined
  const v = o?.[m[2]]
  return v === undefined || v === null ? null : String(v)
}
const likeRe = (pat: string) => new RegExp(`^${pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`, 'is')

/** `generated[table](row)`: columns Postgres would compute (GENERATED ALWAYS), applied on insert and update. */
export function memdb(uniques: Record<string, string[]>, generated: Record<string, (row: Row) => Row> = {}) {
  const tables: Record<string, Row[]> = {}
  let nextId = 1
  const table = (t: string) => (tables[t] ??= [])

  function from(t: string) {
    let op: 'select' | 'upsert' | 'update' | 'delete' = 'select'
    let payload: Row | Row[] | null = null
    let opts: { onConflict?: string; ignoreDuplicates?: boolean } = {}
    const filters: ((r: Row) => boolean)[] = []
    let limit = Infinity
    let offset = 0
    let single: 'one' | 'maybe' | null = null
    let count: 'exact' | null = null
    let head = false
    let returning = false
    const orders: { c: string; asc: boolean }[] = []

    const run = (): { data: unknown; error: null | { message: string; code?: string } } => {
      const rows = table(t)
      let out: Row[] = []
      if (op === 'select') out = rows.filter((r) => filters.every((f) => f(r)))
      else if (op === 'update') {
        out = rows.filter((r) => filters.every((f) => f(r)))
        for (const r of out) Object.assign(r, payload, generated[t]?.({ ...r, ...(payload as Row) }) ?? {})
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
            const base = { id: p.id ?? (t === 'lume_slack_channels' ? `00000000-0000-0000-0000-${String(nextId).padStart(12, '0')}` : nextId), ...p }
            const row = { ...base, ...(generated[t]?.(base) ?? {}) }
            nextId++
            rows.push(row)
            out.push(row)
          }
        }
      }
      if (op === 'select' && orders.length) {
        out = [...out].sort((a, b) => {
          for (const o of orders) {
            const x = at(a, o.c)
            const y = at(b, o.c)
            if (x === y) continue
            if (x === null || x === undefined) return 1
            if (y === null || y === undefined) return -1
            return (x < y ? -1 : 1) * (o.asc ? 1 : -1)
          }
          return 0
        })
      }
      const total = out.length
      out = out.slice(offset, offset + limit).map((r) => ({ ...r }))
      if (count) return { data: head ? null : out, count: total, error: null } as never
      if ((op === 'update' || op === 'delete') && !returning) return { data: null, error: null }
      if (single === 'one') return out.length === 1 ? { data: out[0], error: null } : { data: null, error: { message: 'not one row', code: 'PGRST116' } }
      if (single === 'maybe') return { data: out[0] ?? null, error: null }
      return { data: out, error: null }
    }

    const b: Record<string, unknown> = {
      select: (_cols?: string, o?: { count?: 'exact'; head?: boolean }) => {
        if (op !== 'select') returning = true
        if (o?.count) count = o.count
        if (o?.head) head = true
        return b
      },
      upsert: (p: Row | Row[], o: typeof opts = {}) => ((op = 'upsert'), (payload = p), (opts = o), b),
      insert: (p: Row | Row[]) => ((op = 'upsert'), (payload = p), b),
      update: (p: Row) => ((op = 'update'), (payload = p), b),
      delete: () => ((op = 'delete'), b),
      eq: (c: string, v: unknown) => (filters.push((r) => at(r, c) === v), b),
      not: (c: string, operator: string, v: unknown) => (filters.push((r) => !(operator === 'is' ? (at(r, c) ?? null) === v : at(r, c) === v)), b),
      ilike: (c: string, pat: string) => (filters.push((r) => likeRe(pat).test(String(at(r, c) ?? ''))), b),
      or: (expr: string) => {
        const terms = expr.split(',').map((t) => /^(.+?)\.ilike\.(.*)$/.exec(t)!).map((m) => [m[1], likeRe(m[2])] as const)
        filters.push((r) => terms.some(([c, re]) => re.test(String(at(r, c) ?? ''))))
        return b
      },
      gte: (c: string, v: number) => (filters.push((r) => (at(r, c) as number) >= v), b),
      lt: (c: string, v: string | number) => (filters.push((r) => at(r, c) !== null && at(r, c) !== undefined && (at(r, c) as string | number) < v), b),
      neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), b),
      is: (c: string, v: unknown) => (filters.push((r) => (at(r, c) ?? null) === v), b),
      in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(at(r, c))), b),
      order: (c: string, o?: { ascending?: boolean }) => (orders.push({ c, asc: o?.ascending !== false }), b),
      range: (from: number, to: number) => ((offset = from), (limit = to - from + 1), b),
      limit: (n: number) => ((limit = n), b),
      maybeSingle: () => ((single = 'maybe'), b),
      single: () => ((single = 'one'), b),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve().then(run).then(resolve, reject),
    }
    return b
  }

  // rpc(name, args): handlers registered by the test (db.rpcs[name] = (args) => data).
  const rpcs: Record<string, (args: Record<string, unknown>) => unknown> = {}
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const h = rpcs[name]
    return h ? { data: h(args), error: null } : { data: null, error: { message: `no rpc ${name}` } }
  }
  return { tables, table, rpcs, client: { from, rpc } }
}
