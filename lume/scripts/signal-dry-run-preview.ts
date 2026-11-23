/**
 * GTM-14 dry-run preview: prints the #sales cards the signal-alerts cron
 * saved while `signal_config.dry_run` is on, as plain text. Read-only
 * (selects only), service role from `.env.local`.
 *
 *   cd lume && npx tsx scripts/signal-dry-run-preview.ts [limit]
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { renderCardAsText } from '../lib/slack/signalCard'

// Minimal .env.local loader (same as smoke-db); existing env wins.
try {
  const text = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (!m || process.env[m[1]] !== undefined) continue
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
} catch {
  // env may already be set
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (lume/.env.local)')
    process.exit(2)
  }
  const limit = Math.min(Math.max(Number(process.argv[2]) || 20, 1), 200)
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })

  const people = await sb.from('signal_people').select('id, name, card').eq('alert_status', 'dry_run').order('id', { ascending: true }).limit(limit)
  if (people.error) throw new Error(`signal_people: ${people.error.message}`)
  const digests = await sb.from('signal_posts').select('post_id, digest_card').eq('digest_status', 'dry_run').order('posted_at', { ascending: true }).limit(limit)
  if (digests.error) throw new Error(`signal_posts: ${digests.error.message}`)

  console.log(`dry-run commenter cards: ${people.data.length}, digests: ${digests.data.length}\n`)
  for (const p of people.data) {
    console.log(`════ person ${p.id} ════`)
    console.log(renderCardAsText(p.card))
    console.log()
  }
  for (const d of digests.data) {
    console.log(`════ digest for post ${d.post_id} ════`)
    console.log(renderCardAsText(d.digest_card))
    console.log()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
