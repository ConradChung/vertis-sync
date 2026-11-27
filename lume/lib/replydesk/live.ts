import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { callUsd } from '@/lib/replydesk/config'
import type { AiPort, Deps, SlackPort } from '@/lib/replydesk/engine'
import { liveStore } from '@/lib/replydesk/store'
import { slackApi } from '@/lib/slack/api'
import { getBotToken } from '@/lib/slack/store'

/**
 * Live ports: Claude through the Anthropic SDK (ANTHROPIC_API_KEY), Slack
 * through the existing Lume bot of the workspace the message came from.
 */

let client: Anthropic | null = null
// Short timeout: a drafted answer must land within a minute of the inbound reply.
const anthropic = () => (client ??= new Anthropic({ timeout: 25_000, maxRetries: 1 }))

export const liveAi: AiPort = {
  async call({ model, system, user, schema, maxTokens }) {
    // No server-side fallback: a refusal is a failed try (the macro fallback covers it), priced from res.model.
    const res = await anthropic().messages.create({
      model,
      max_tokens: maxTokens,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }],
    })
    const text = res.content.find((b) => b.type === 'text')
    const u = res.usage
    return {
      model: res.model,
      text: text && text.type === 'text' ? text.text : null,
      stop: res.stop_reason ?? 'unknown',
      usd: callUsd(res.model, {
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        cache_creation_input_tokens: u.cache_creation_input_tokens,
        cache_read_input_tokens: u.cache_read_input_tokens,
      }),
      input_tokens: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
      output_tokens: u.output_tokens,
    }
  },
}

async function token(team: string): Promise<string> {
  const bot = await getBotToken(team)
  if (!bot) throw new Error('slack_install_missing_or_revoked')
  return bot.token
}

export const liveSlack: SlackPort = {
  async botUserId(team) {
    return (await getBotToken(team))?.bot_user_id ?? null
  },
  async postThread(team, channel, threadTs, msg) {
    try {
      const res = await slackApi('chat.postMessage', await token(team), { channel, thread_ts: threadTs, text: msg.text, blocks: msg.blocks, unfurl_links: false, unfurl_media: false })
      return typeof res.ts === 'string' ? { ts: res.ts } : { error: 'no_ts' }
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'slack_failed' }
    }
  },
  async update(team, channel, ts, msg) {
    await slackApi('chat.update', await token(team), { channel, ts, text: msg.text, blocks: msg.blocks })
  },
}

export const liveDeps = (): Deps => ({ store: liveStore, ai: liveAi, slack: liveSlack, now: () => new Date() })
