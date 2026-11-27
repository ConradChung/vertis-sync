/**
 * One-off: look up the unit count (doors) once per company for hiring rows
 * that are shown, have a company and have no count. Perplexity + Haiku only,
 * through the hiring lane's own spend ledger and monthly cap, stopping at $1
 * for the whole run. Prints counts and cost, never a key.
 *
 *   cd lume
 *   npm run hiring:doors             # dry run: how many companies are missing
 *   npm run hiring:doors -- --run    # spend (up to $1)
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PERPLEXITY_API_KEY
 * and ANTHROPIC_API_KEY from the environment or the file named by ENV_FILE
 * (default .env.local).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { doorParseRequest, doorQuestion, groundDoors, haikuUsd, perplexityRequest, PPLX_CALL_USD, PPLX_URL } from '../lib/hiring/checkPrompt'
import { BACKFILL_BUDGET_USD, runDoorBackfill, type BackfillStore, type DoorLookup, type MissingRow } from '../lib/hiring/doorsBackfill'
import { monthToDate, parseHiringConfig, HIRING_CONFIG_KEY } from '../lib/hiring/config'
import { parseJsonResponse } from '../lib/hiring/live'

for (const f of [process.env.ENV_FILE, '.env.local']) {
  if (!f) continue
  try {
    for (const line of readFileSync(resolve(process.cwd(), f), 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
      if (!m || process.env[m[1]] !== undefined) continue
      process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
    }
  } catch {
    /* no file */
  }
}
const need = (k: string) => {
  const v = process.env[k]?.trim()
  if (!v) {
    console.error(`${k} is not set`)
    process.exit(2)
  }
  return v
}
const sb = createClient(need('NEXT_PUBLIC_SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })
const must = <T>(r: { data: T; error: { message: string } | null }, op: string): T => {
  if (r.error) throw new Error(`${op}: ${r.error.message}`)
  return r.data
}

const store: BackfillStore = {
  async getConfig() {
    return parseHiringConfig(must(await sb.from('lume_settings').select('value').eq('key', HIRING_CONFIG_KEY).maybeSingle(), 'config')?.value)
  },
  async monthSpend(from) {
    return monthToDate(must(await sb.from('signal_hiring_spend').select('usd, status').gte('created_at', from), 'spend') as { usd: number | string; status: string }[])
  },
  async addSpend(e) {
    must(await sb.from('signal_hiring_spend').insert({ ...e, settled_at: new Date().toISOString() }), 'addSpend')
  },
  async listMissing() {
    const rows = must(
      await sb
        .from('signal_hiring')
        .select('id, signal, company_name, company_domain, location')
        .eq('stage', 'done')
        .is('skip_reason', null)
        .is('door_count', null)
        .not('company_name', 'is', null)
        .order('id', { ascending: false })
        .limit(2000),
      'listMissing'
    )
    return rows as MissingRow[]
  },
  async saveDoors(ids, key, d) {
    const at = new Date().toISOString()
    must(await sb.from('signal_hiring').update({ door_count: d.door_count, door_count_source: d.door_count_source, door_count_confidence: d.door_count_confidence, updated_at: at }).in('id', ids).is('door_count', null), 'saveDoors rows')
    must(await sb.from('signal_company_checks').update({ door_count: d.door_count, door_count_source: d.door_count_source, door_count_confidence: d.door_count_confidence }).eq('domain', key).is('door_count', null), 'saveDoors check')
  },
}

const lookup: DoorLookup = async (company, location) => {
  const res = await fetch(PPLX_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${need('PERPLEXITY_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(perplexityRequest(doorQuestion(company, location))),
    signal: AbortSignal.timeout(45_000),
  })
  if (!res.ok) throw new Error(`perplexity HTTP ${res.status}`)
  const b = (await res.json()) as { choices?: { message?: { content?: unknown } }[]; citations?: unknown; usage?: { cost?: { total_cost?: unknown } } }
  const answer = b.choices?.[0]?.message?.content
  if (typeof answer !== 'string') throw new Error('perplexity: no answer')
  const citations = Array.isArray(b.citations) ? b.citations.filter((x): x is string => typeof x === 'string') : []
  const pplx = Number(b.usage?.cost?.total_cost)
  const h = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': need('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify(doorParseRequest(company, answer, citations)),
    signal: AbortSignal.timeout(45_000),
  })
  if (!h.ok) throw new Error(`anthropic HTTP ${h.status}`)
  const { json, usage } = parseJsonResponse(await h.json())
  return { doors: groundDoors(json, citations), usd: (Number.isFinite(pplx) && pplx > 0 ? pplx : PPLX_CALL_USD) + haikuUsd(usage) }
}

if (process.argv.includes('--run')) {
  console.log(JSON.stringify(await runDoorBackfill({ store, lookup }), null, 2))
} else {
  const rows = await store.listMissing()
  const companies = new Set(rows.map((r) => (r.company_domain ?? r.company_name ?? '').toLowerCase()))
  console.log(`shown hiring rows without a count: ${rows.length}; companies: ${companies.size}. Re-run with --run to look them up (stops at $${BACKFILL_BUDGET_USD}).`)
}
