import { notifyOutcome } from '@/lib/adapters/telegram.notify'
import type { TelegramResult } from '@/lib/adapters/telegram'
import { CHECK_IDS, DEFAULT_SLACK_TEST_CHANNEL, scrubDetail, type CheckId, type CheckResult, type Env, type FetchLike, type HealthRun } from '@/lib/health/model'

/**
 * Config health live checks. Run only when the owner clicks "Run checks"
 * (POST /api/settings/health), never on page load. Pure: fetch, env, clock
 * and the Slack / Telegram senders are injected (lib/health/service.ts wires
 * the real ones). Each returns `{ ok, detail, ms }`; details never carry a
 * secret value (`scrubDetail` runs over every one in `runChecks`).
 */

export const APIFY_ME_URL = 'https://api.apify.com/v2/users/me'
export const CHECK_TIMEOUT_MS = 10_000
export const SALES_CHANNEL = 'sales'

type Outcome = { ok: boolean; detail: string }

const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))
const isTimeout = (e: unknown) => e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')

async function timed(now: () => number, fn: () => Promise<Outcome>): Promise<CheckResult> {
  const start = now()
  let out: Outcome
  try {
    out = await fn()
  } catch (e) {
    out = { ok: false, detail: isTimeout(e) ? `timed out after ${CHECK_TIMEOUT_MS / 1000} s` : `error: ${errMessage(e)}` }
  }
  return { ...out, ms: Math.max(0, Math.round(now() - start)) }
}

/** "Lume config check ✓ <time>", the time in the owner's zone. */
export function checkMessage(at: Date): string {
  const t = at.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'short' })
  return `Lume config check ✓ ${t} PT`
}

// ── Apify ────────────────────────────────────────────────────────────────

export async function checkApify(fetch: FetchLike, env: Env): Promise<Outcome> {
  const token = env('APIFY_API_TOKEN')?.trim()
  if (!token) return { ok: false, detail: 'APIFY_API_TOKEN missing' }
  // Bearer header, never ?token= (keeps the token out of URLs and logs).
  const res = await fetch(APIFY_ME_URL, { method: 'GET', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS), cache: 'no-store' })
  await res.body?.cancel().catch(() => {})
  if (res.ok) return { ok: true, detail: 'token valid' }
  if (res.status === 401 || res.status === 403) return { ok: false, detail: `Apify ${res.status}: token rejected` }
  return { ok: false, detail: `Apify ${res.status}` }
}

// ── Telegram ─────────────────────────────────────────────────────────────

export async function checkTelegram(send: (text: string) => Promise<TelegramResult>, at: Date): Promise<Outcome> {
  const o = notifyOutcome(await send(checkMessage(at)))
  return o.status === 'sent' ? { ok: true, detail: 'sent to TELEGRAM_CHAT_ID' } : { ok: false, detail: `${o.status}: ${o.error}` }
}

// ── Slack ────────────────────────────────────────────────────────────────

export interface SlackCheckDeps {
  configured: boolean
  /** config_health.slack_test_channel; null = #lume-health. */
  channelName: string | null
  /** config_health.slack_team_id, when several installs are live. */
  teamId: string | null
  listInstalls: () => Promise<{ team_id: string; revoked_at: string | null }[]>
  getBotToken: (team: string) => Promise<{ token: string } | null>
  listChannels: (token: string) => Promise<{ id: string; name: string; is_member: boolean }[]>
  post: (token: string, channel: string, text: string) => Promise<void>
}

export const normalizeChannel = (name: string | null | undefined) => (name ?? '').trim().replace(/^#+/, '').trim().toLowerCase()

export const channelNotFound = (name: string) => `test channel not found (create #${name} and invite the bot)`

export async function checkSlack(d: SlackCheckDeps, at: Date): Promise<Outcome> {
  const name = normalizeChannel(d.channelName) || DEFAULT_SLACK_TEST_CHANNEL
  // Refused before any Slack call: a health ping never lands in #sales.
  if (name === SALES_CHANNEL) return { ok: false, detail: 'refusing to post to #sales; set config_health.slack_test_channel to a test channel' }
  if (!d.configured) return { ok: false, detail: 'Slack app not configured' }
  let team = d.teamId
  if (!team) {
    const live = (await d.listInstalls()).filter((i) => !i.revoked_at)
    if (live.length !== 1) return { ok: false, detail: live.length ? 'several Slack installs; set config_health.slack_team_id' : 'no Slack install' }
    team = live[0].team_id
  }
  const bot = await d.getBotToken(team)
  if (!bot) return { ok: false, detail: 'Slack install missing or revoked' }
  let channels
  try {
    channels = await d.listChannels(bot.token)
  } catch (e) {
    return { ok: false, detail: `Slack error: ${slackCode(e)}` }
  }
  const ch = channels.find((c) => normalizeChannel(c.name) === name)
  if (!ch || !ch.is_member) return { ok: false, detail: channelNotFound(name) }
  if (normalizeChannel(ch.name) === SALES_CHANNEL) return { ok: false, detail: 'refusing to post to #sales' }
  try {
    await d.post(bot.token, ch.id, checkMessage(at))
  } catch (e) {
    return { ok: false, detail: `Slack error: ${slackCode(e)}` }
  }
  return { ok: true, detail: `posted to #${name}` }
}

function slackCode(e: unknown): string {
  const code = e && typeof e === 'object' && 'code' in e && typeof (e as { code: unknown }).code === 'string' ? (e as { code: string }).code : null
  return code ?? errMessage(e)
}

// ── Railway worker ───────────────────────────────────────────────────────

/** workers/crawl/app.py serves GET /health (no secret needed). */
export async function checkWorker(fetch: FetchLike, env: Env): Promise<Outcome> {
  const base = env('CRAWL_WORKER_URL')?.trim().replace(/\/+$/, '')
  if (!base) return { ok: false, detail: 'CRAWL_WORKER_URL missing' }
  if (!/^https?:\/\//i.test(base)) return { ok: false, detail: 'CRAWL_WORKER_URL is not an http(s) URL' }
  const res = await fetch(`${base}/health`, { method: 'GET', signal: AbortSignal.timeout(CHECK_TIMEOUT_MS), cache: 'no-store' })
  await res.body?.cancel().catch(() => {})
  return res.ok ? { ok: true, detail: `reachable (HTTP ${res.status})` } : { ok: false, detail: `worker answered HTTP ${res.status}` }
}

// ── all four ─────────────────────────────────────────────────────────────

export interface RunDeps {
  fetch: FetchLike
  env: Env
  now: () => number
  sendTelegram: (text: string) => Promise<TelegramResult>
  slack: SlackCheckDeps
  /** Values to scrub from every detail (all known secret env values). */
  secrets: readonly string[]
}

export async function runChecks(d: RunDeps): Promise<HealthRun> {
  const at = new Date(d.now())
  const run: Record<CheckId, () => Promise<Outcome>> = {
    apify: () => checkApify(d.fetch, d.env),
    telegram: () => checkTelegram(d.sendTelegram, at),
    slack: () => checkSlack(d.slack, at),
    worker: () => checkWorker(d.fetch, d.env),
  }
  const settled = await Promise.all(CHECK_IDS.map((id) => timed(d.now, run[id])))
  const results = {} as Record<CheckId, CheckResult>
  CHECK_IDS.forEach((id, i) => {
    results[id] = { ...settled[i], detail: scrubDetail(settled[i].detail, d.secrets) }
  })
  return { checked_at: at.toISOString(), results }
}
