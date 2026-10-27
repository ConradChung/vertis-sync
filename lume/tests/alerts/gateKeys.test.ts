import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { gateKey } from '@/lib/alerts'

/**
 * One feed row per gate: the pipelines (edge functions) and Lume (gate-opened
 * ping, createAction, import) must build the same dedupe_key for the same
 * gate, `<target id>:<gate kind>`, with no per-instance suffix — a gate that
 * re-opens is un-acked by lume_alert_upsert instead. Every dedupe_key in the
 * edge functions and in Lume goes through a gateKey() helper.
 */
const REPO = fileURLToPath(new URL('../../..', import.meta.url))

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...tsFiles(p))
    else if (/\.tsx?$/.test(name) && !/(_test|\.test)\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

function dedupeKeys(files: string[]) {
  const found: { file: string; expr: string }[] = []
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/dedupe_key:\s*([^,}\n]+)/g)) found.push({ file: relative(REPO, f), expr: m[1].trim() })
  }
  return found
}

describe('gate dedupe keys', () => {
  it('gateKey is <target id>:<gate kind>', () => {
    expect(gateKey('7db3d841-252c-4572-95ec-bc110727df8d', 'stall')).toBe('7db3d841-252c-4572-95ec-bc110727df8d:stall')
  })

  it('every dedupe_key in the edge functions is built with gateKey()', () => {
    const keys = dedupeKeys(tsFiles(join(REPO, 'supabase/functions')).filter((f) => !f.includes('/_shared/')))
    expect(keys.length).toBeGreaterThanOrEqual(10)
    expect(keys.filter((k) => !k.expr.startsWith('gateKey('))).toEqual([])
  })

  it('every dedupe_key in Lume is built with gateKey()', () => {
    const lume = join(REPO, 'lume')
    // Only alert() callers (lib/crm has its own, unrelated dedupe_key column).
    const files = [...tsFiles(join(lume, 'app')), ...tsFiles(join(lume, 'lib'))]
      .filter((f) => !/lib\/alerts(Store)?\.ts$/.test(f) && readFileSync(f, 'utf8').includes("from '@/lib/alerts'"))
    const keys = dedupeKeys(files)
    expect(keys.length).toBeGreaterThanOrEqual(4)
    expect(keys.filter((k) => !k.expr.startsWith('gateKey('))).toEqual([])
  })
})
