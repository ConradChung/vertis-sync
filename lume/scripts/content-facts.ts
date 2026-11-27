/**
 * The LinkedIn draft generator's facts bank: list, add, retire, restore.
 * The generator may state only active facts, so this is how a new real
 * number, story, quote, offer or objection gets in, and how a stale one
 * goes out (retired facts are kept, never deleted).
 *
 *   cd lume
 *   npm run content:facts -- list
 *   npm run content:facts -- add number "Customer result: ..." "kaspen.ai, read 2026-12-01"
 *   npm run content:facts -- retire 7
 *   npm run content:facts -- restore 7
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the
 * environment or lume/.env.local. Prints no secrets.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { FACT_KINDS, isFactKind } from '../lib/content/facts'

try {
  const text = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (!m || process.env[m[1]] !== undefined) continue
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
} catch {
  // env may come from the shell instead
}

const USAGE = `usage:
  content:facts list [--all]
  content:facts add <${FACT_KINDS.join('|')}> "<text>" "<source>"
  content:facts retire <id>
  content:facts restore <id>`

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required')
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const [cmd, ...rest] = process.argv.slice(2)

  if (cmd === 'list') {
    let q = sb.from('content_facts').select('id, kind, text, source, active').order('id')
    if (!rest.includes('--all')) q = q.eq('active', true)
    const res = await q
    if (res.error) throw new Error(res.error.message)
    for (const f of res.data ?? []) console.log(`#${f.id} [${f.kind}${f.active ? '' : ', retired'}] ${f.text}  (${f.source})`)
    return
  }
  if (cmd === 'add') {
    const [kind, text, source] = rest
    if (!isFactKind(kind) || !text?.trim() || !source?.trim()) throw new Error(USAGE)
    const res = await sb.from('content_facts').insert({ kind, text: text.trim(), source: source.trim() }).select('id').single()
    if (res.error) throw new Error(res.error.message)
    console.log(`added fact #${res.data.id}`)
    return
  }
  if (cmd === 'retire' || cmd === 'restore') {
    const id = Number(rest[0])
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error(USAGE)
    const patch = cmd === 'retire' ? { active: false, retired_at: new Date().toISOString() } : { active: true, retired_at: null }
    const res = await sb.from('content_facts').update(patch).eq('id', id).select('id')
    if (res.error) throw new Error(res.error.message)
    console.log((res.data ?? []).length ? `${cmd}d fact #${id}` : `no fact #${id}`)
    return
  }
  throw new Error(USAGE)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
