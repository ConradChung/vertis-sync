import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { DbError } from '@/lib/db/service'
import { sendMessage } from '@/lib/adapters/telegram'
import { isSlackConfigured } from '@/lib/slack/config'
import { listChannels, slackApi } from '@/lib/slack/api'
import { getBotToken, listInstalls } from '@/lib/slack/store'
import { runChecks } from '@/lib/health/checks'
import { fetchEdgePresence } from '@/lib/health/edge'
import { LUME_ENV_NAMES } from '@/lib/health/names'
import {
  CONFIG_HEALTH_KEY,
  mergeConfigHealth,
  parseConfigHealth,
  presence,
  secretValues,
  type EdgePresence,
  type Env,
  type HealthRun,
  type PresenceRow,
} from '@/lib/health/model'

/** Thin adapters around lib/health/* (the logic and its tests live there). */

const processEnv: Env = (k) => process.env[k]

export interface HealthState {
  vercel: PresenceRow[]
  edge: EdgePresence
  slack_test_channel: string | null
  last: HealthRun | null
}

async function readSetting(): Promise<unknown> {
  const res = await createServiceClient().from('lume_settings').select('value').eq('key', CONFIG_HEALTH_KEY).maybeSingle()
  if (res.error) throw new DbError('readConfigHealth', res.error)
  return res.data?.value ?? null
}

/** GET: presence (booleans only) + the last stored run. No live check runs here. */
export async function healthState(): Promise<HealthState> {
  const [edge, raw] = await Promise.all([fetchEdgePresence((u, i) => fetch(u, i), processEnv), readSetting().catch(() => null)])
  const cfg = parseConfigHealth(raw)
  return { vercel: presence(LUME_ENV_NAMES, processEnv), edge, slack_test_channel: cfg.slack_test_channel, last: cfg.last }
}

/** POST: run the four live checks, store the run (merged into config_health), return it. */
export async function runHealthChecks(): Promise<HealthRun> {
  const prev = await readSetting()
  const cfg = parseConfigHealth(prev)
  const run = await runChecks({
    fetch: (u, i) => fetch(u, i),
    env: processEnv,
    now: () => Date.now(),
    sendTelegram: (text) => sendMessage(text, { disablePreview: true }),
    secrets: secretValues(LUME_ENV_NAMES, processEnv),
    slack: {
      configured: isSlackConfigured(),
      channelName: cfg.slack_test_channel,
      teamId: cfg.slack_team_id,
      listInstalls,
      getBotToken,
      listChannels,
      post: async (token, channel, text) => {
        await slackApi('chat.postMessage', token, { channel, text, unfurl_links: false, unfurl_media: false })
      },
    },
  })
  const res = await createServiceClient()
    .from('lume_settings')
    .upsert({ key: CONFIG_HEALTH_KEY, value: mergeConfigHealth(prev, run), updated_at: new Date().toISOString() })
  if (res.error) console.error('[health] could not store config_health:', res.error.message)
  return run
}
