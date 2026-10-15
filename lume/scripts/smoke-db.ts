/**
 * Live read check against the Supabase project with the service role from
 * `.env.local`. Prints row counts only — no PII.
 *
 *   LUME_SMOKE=1 npm run smoke:db
 *
 * `--conditions=react-server` (in the npm script) resolves the `server-only`
 * package to its empty build, which is what lets lib/db/service load under
 * plain Node. Refuses to run without LUME_SMOKE=1 so it is never fired by
 * accident from a CI step or a stray `tsx` invocation.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

if (process.env.LUME_SMOKE !== '1') {
  console.error('refusing to run: set LUME_SMOKE=1 to hit the live database')
  process.exit(2)
}

// Minimal .env.local loader (no dotenv dependency); existing env wins.
try {
  const text = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (!m) continue
    const [, key, rawValue] = m
    if (process.env[key] !== undefined) continue
    process.env[key] = rawValue.replace(/^(['"])(.*)\1$/, '$2')
  }
} catch {
  console.error('.env.local not found next to package.json')
  process.exit(2)
}

async function main() {
  // Imported after the env is loaded: the service client reads it at first use.
  const { getGates, getLeadBank, getOverview, getScheduledJobs } = await import('../lib/db/service')

  const gates = await getGates()
  console.log(`gates: ${gates.length}`, gates.map((g) => g.kind).join(', ') || '(none)')

  const overview = await getOverview()
  console.log(
    `overview: pending_gates=${overview.pending_gates} replies_today=${overview.replies_today} ` +
      `bounces_24h=${overview.bounces_24h} active_jobs=${overview.active_jobs} ` +
      `lead_bank_queued=${overview.lead_bank_queued} recent_events=${overview.recent_events.length} ` +
      `events_last_at=${overview.events_last_at ?? 'null'}`
  )

  const jobs = await getScheduledJobs()
  const byRunner = jobs.reduce<Record<string, number>>((acc, j) => ((acc[j.runner] = (acc[j.runner] ?? 0) + 1), acc), {})
  console.log(`scheduled jobs: ${jobs.length}`, JSON.stringify(byRunner))

  const page = await getLeadBank({ pageSize: 5 })
  console.log(`lead bank: ${page.rows.length} rows on page ${page.page} (total ${page.total})`)
}

main().catch((err) => {
  console.error('smoke failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
