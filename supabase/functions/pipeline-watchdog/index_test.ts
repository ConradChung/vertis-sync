// Run: deno test --allow-env pipeline-watchdog/
import { assert, assertEquals } from 'jsr:@std/assert@1'
import { json, prepareModule, stubFetch } from '../_shared/test_fetch.ts'

prepareModule({ SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'svc', TELEGRAM_BOT_TOKEN: 'tg', TELEGRAM_CHAT_ID: '1' })
const { checkForStalls, stallCandidatesPath } = await import('./index.ts')

const NOW = Date.parse('2026-11-08T03:00:00Z')
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * 3600_000).toISOString()

Deno.test('candidates: processing jobs of any age; pending only when under 24 h; NULL finder_status kept; a stale awaiting prompt (> 1 h) re-checked', () => {
  const q = decodeURIComponent(stallCandidatesPath(NOW))
  assert(q.includes(`or(status.eq.processing,and(status.eq.pending,created_at.gt.${iso(24)}))`), q)
  assert(q.includes('or(finder_status.is.null,finder_status.neq.awaiting_decision)'), q)
  assert(q.includes(`or(and(watchdog_status.eq.idle,or(watchdog_notified_at.is.null,watchdog_notified_at.lt.${iso(1)})),and(watchdog_status.eq.awaiting,watchdog_notified_at.lt.${iso(1)}))`), q)
  assert(!q.includes('&created_at=gt.'), 'no blanket created_at cutoff')
})

Deno.test('job 16f26ffc: processing, created 2 days ago, an unanswered prompt from 2 days ago, no heartbeat for 2 days → flagged again with Resume', async () => {
  const realNow = Date.now
  Date.now = () => NOW
  const job = { id: '16f26ffc-f8e5-47a5-9e1b-7532f61dad75', filename: 'pm.csv', total_rows: 5272, processed_rows: 5272, status: 'processing', created_at: iso(48), updated_at: iso(47), watchdog_status: 'awaiting', watchdog_notified_at: iso(43) }
  const f = stubFetch([
    [(u, m) => u.startsWith('https://db.test/rest/v1/validation_jobs?') && m === 'GET', () => json([job])],
    [(u) => u.includes('validation_rows?job_id='), () => json([])],
    [(u, m) => u.startsWith('https://db.test/rest/v1/validation_jobs?id=eq.') && m === 'PATCH', () => json([{ ...job, watchdog_status: 'awaiting' }])],
    [(u) => u.startsWith('https://db.test/rest/v1/'), () => json([])],
    [(u) => u.startsWith('https://api.telegram.org/'), () => json({ ok: true, result: { message_id: 1 } })],
  ])
  try {
    const out = await checkForStalls()
    assertEquals(out.notified, [job.id])
    const claim = f.calls.find((c) => c.method === 'PATCH' && c.url.includes('validation_jobs?id=eq.'))!
    // The claim matches the prompt it found, so two ticks can't both re-send.
    assert(claim.url.includes('watchdog_status=eq.awaiting'), claim.url)
    assert(claim.url.includes(`watchdog_notified_at=eq.${encodeURIComponent(job.watchdog_notified_at)}`) || claim.url.includes(`watchdog_notified_at=eq.${job.watchdog_notified_at}`), claim.url)
    const tg = f.calls.find((c) => c.url.includes('api.telegram.org'))!
    assert(tg.body!.includes(`wd_resume:${job.id}`))
  } finally {
    Date.now = realNow
    f.restore()
  }
})

Deno.test('a fresh idle job with a recent heartbeat is left alone', async () => {
  const realNow = Date.now
  Date.now = () => NOW
  const job = { id: 'j', filename: 'f', total_rows: 10, processed_rows: 5, status: 'processing', created_at: iso(2), updated_at: new Date(NOW - 5 * 60_000).toISOString(), watchdog_status: 'idle', watchdog_notified_at: null }
  const f = stubFetch([
    [(u, m) => u.startsWith('https://db.test/rest/v1/validation_jobs?') && m === 'GET', () => json([job])],
    [(u) => u.startsWith('https://db.test/rest/v1/'), () => json([])],
  ])
  try {
    assertEquals((await checkForStalls()).notified, [])
    assertEquals(f.calls.filter((c) => c.method === 'PATCH').length, 0)
  } finally {
    Date.now = realNow
    f.restore()
  }
})
