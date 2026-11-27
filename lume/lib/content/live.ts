import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { callUsd, contentModel, type ContentConfig } from '@/lib/content/config'
import type { AiPort, Deps, SlackPort } from '@/lib/content/engine'
import { OUTPUT_SCHEMA } from '@/lib/content/prompt'
import { loadReferences } from '@/lib/content/references'
import { getContentConfig, liveStore, saveContentSlack } from '@/lib/content/store'
import { listChannels, slackApi } from '@/lib/slack/api'
import { isSlackConfigured } from '@/lib/slack/config'
import { getBotToken, listInstalls } from '@/lib/slack/store'

/**
 * Live ports: Claude through the Anthropic SDK (ANTHROPIC_API_KEY), Slack
 * through the existing Lume bot. The channel is resolved by name once and
 * remembered in content_config.slack, the way signal alerts do it.
 */

let client: Anthropic | null = null
const anthropic = () => (client ??= new Anthropic({ timeout: 150_000, maxRetries: 1 }))

export const liveAi: AiPort = {
  async write({ model, system, user }) {
    const res = await anthropic().beta.messages.create({
      model,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: OUTPUT_SCHEMA as unknown as Record<string, unknown> } },
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }],
    })
    const text = res.content.find((b) => b.type === 'text')
    const u = res.usage
    const usage = {
      input_tokens: u.input_tokens,
      output_tokens: u.output_tokens,
      cache_creation_input_tokens: u.cache_creation_input_tokens,
      cache_read_input_tokens: u.cache_read_input_tokens,
    }
    return {
      text: text && text.type === 'text' ? text.text : null,
      stop: res.stop_reason ?? 'unknown',
      usd: callUsd(model, usage),
      input_tokens: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
      output_tokens: u.output_tokens,
    }
  },
}

type Target = { team: string; channel: string; token: string }

export async function resolveContentChannel(cfg: ContentConfig): Promise<Target | { error: string }> {
  if (!isSlackConfigured()) return { error: 'slack_not_configured' }
  let team = cfg.slack.team_id
  if (!team) {
    const live = (await listInstalls()).filter((i) => !i.revoked_at)
    if (live.length !== 1) return { error: live.length ? 'several_slack_installs_set_content_config_team_id' : 'no_slack_install' }
    team = live[0].team_id
  }
  const bot = await getBotToken(team)
  if (!bot) return { error: 'slack_install_missing_or_revoked' }
  if (cfg.slack.team_id === team && cfg.slack.channel_id) return { team, channel: cfg.slack.channel_id, token: bot.token }
  const name = cfg.slack.channel_name
  const ch = (await listChannels(bot.token)).find((c) => c.name === name)
  if (!ch) return { error: `channel_not_found:#${name}` }
  if (!ch.is_member) return { error: `bot_not_in_channel:#${name}` }
  await saveContentSlack(cfg, team, ch.id)
  return { team, channel: ch.id, token: bot.token }
}

export const liveSlack: SlackPort = {
  async post(cfg, msg) {
    const t = await resolveContentChannel(cfg)
    if ('error' in t) return t
    try {
      const res = await slackApi('chat.postMessage', t.token, { channel: t.channel, text: msg.text, blocks: msg.blocks, unfurl_links: false, unfurl_media: false })
      return typeof res.ts === 'string' ? { team: t.team, channel: t.channel, ts: res.ts } : { error: 'no_ts' }
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'slack_failed' }
    }
  },
}

export const liveDeps = (): Deps => ({ store: liveStore, ai: liveAi, slack: liveSlack, refs: loadReferences, model: contentModel() })
export { getContentConfig }
