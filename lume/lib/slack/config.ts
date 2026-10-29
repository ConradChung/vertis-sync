import { configuredBaseUrl } from '@/lib/http/origin'
import { parseTokenKey } from '@/lib/slack/crypto'

/**
 * The client Slack app's settings (3g). Everything Slack-facing answers
 * "not configured" (no posts, 503 on the Slack routes, a notice in Settings)
 * until all four env vars are set; a malformed LUME_SLACK_TOKEN_KEY counts
 * as missing. Scopes are the minimum: post and update messages, read
 * mentions, list public and private channels for binding. No users:read
 * (Lume records Slack user ids, never looks them up).
 */

export const SLACK_ENV = ['SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET', 'SLACK_SIGNING_SECRET', 'LUME_SLACK_TOKEN_KEY'] as const

export const SLACK_BOT_SCOPES = ['chat:write', 'app_mentions:read', 'channels:read', 'groups:read'] as const

export const SLACK_CALLBACK_PATH = '/api/slack/oauth/callback'

export interface SlackConfig {
  configured: boolean
  missing: (typeof SLACK_ENV)[number][]
}

export function slackConfig(): SlackConfig {
  const missing = SLACK_ENV.filter((name) => {
    const v = process.env[name]?.trim()
    if (!v) return true
    return name === 'LUME_SLACK_TOKEN_KEY' && !parseTokenKey(v)
  })
  return { configured: missing.length === 0, missing }
}

export const isSlackConfigured = () => slackConfig().configured

/** The OAuth redirect: LUME_URL's, else the request's origin (local dev). Must match the manifest. */
export function slackRedirectUri(requestOrigin: string): string {
  return `${configuredBaseUrl() || requestOrigin.replace(/\/+$/, '')}${SLACK_CALLBACK_PATH}`
}

/** The OAuth state cookie (httpOnly, scoped to the callback path, 10 minutes). */
export const SLACK_STATE_COOKIE = 'lume_slack_state'
