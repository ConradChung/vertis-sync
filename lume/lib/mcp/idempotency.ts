import { createHash } from 'node:crypto'
import { z } from 'zod'
import { sb } from './db'
import { McpUserError } from './sanitize'
import type { ToolOutput } from './tool'

/** Optional on every write tool: a repeat with the same key returns the first result instead of writing again. */
export const idempotencyKey = z
  .string()
  .min(8)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/)
  .optional()
  .describe('Optional. Reuse the same key to retry safely: a repeat returns the first result and writes nothing. 8-200 chars of A-Z a-z 0-9 . _ : -')

export type IdemRow = { key: string; tool: string; args_hash: string; result: ToolOutput }
export type IdemStore = {
  get: (key: string) => Promise<IdemRow | null>
  /** false when the key already exists (a concurrent call won). */
  put: (row: IdemRow) => Promise<boolean>
}

/** Key order independent, so {a,b} and {b,a} hash the same. */
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable)
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]))
  return v
}

export function argsHash(args: Record<string, unknown>): string {
  const { idempotency_key: _drop, ...rest } = args
  void _drop
  return createHash('sha256').update(JSON.stringify(stable(rest))).digest('hex')
}

export const tableStore: IdemStore = {
  async get(key) {
    const res = await sb().from('lume_mcp_idempotency').select('key,tool,args_hash,result').eq('key', key).maybeSingle()
    if (res.error) throw res.error
    return (res.data as IdemRow | null) ?? null
  },
  async put(row) {
    const res = await sb().from('lume_mcp_idempotency').insert(row as never)
    if (res.error?.code === '23505') return false
    if (res.error) throw res.error
    return true
  },
}

function replay(tool: string, hash: string, row: IdemRow): ToolOutput {
  if (row.tool !== tool || row.args_hash !== hash) {
    throw new McpUserError('This idempotency_key was already used for a different call. Use a new key.')
  }
  return { data: { ...(row.result.data as object), replayed: true }, refs: row.result.refs }
}

/**
 * Runs `run` once per key. Without a key it just runs. A repeat with the
 * same tool and arguments returns the stored result; the same key with
 * different arguments is refused. The result is stored after the write, so
 * a crash between the two means a retry writes again (each write tool is
 * also idempotent on its own where it can be: acks, stage moves).
 */
export async function withIdempotency(
  tool: string,
  args: Record<string, unknown>,
  run: () => Promise<ToolOutput>,
  store: IdemStore = tableStore,
): Promise<ToolOutput> {
  const key = typeof args.idempotency_key === 'string' ? args.idempotency_key : undefined
  if (!key) return run()
  const hash = argsHash(args)
  const seen = await store.get(key)
  if (seen) return replay(tool, hash, seen)
  const out = await run()
  const stored = await store.put({ key, tool, args_hash: hash, result: out })
  if (!stored) {
    const winner = await store.get(key)
    if (winner) return replay(tool, hash, winner)
  }
  return out
}
