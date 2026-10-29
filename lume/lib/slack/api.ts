import 'server-only'

/**
 * Slack Web API calls (3g). One fixed host (https://slack.com/api/), so no
 * caller-supplied URL is ever fetched: Lume never follows an interaction's
 * `response_url` (it updates posts with chat.update and answers users with
 * chat.postEphemeral instead). 5 s timeout, no redirects. A token is never
 * logged; errors carry Slack's error code only.
 */

export const SLACK_API = 'https://slack.com/api/'
export const SLACK_TIMEOUT_MS = 5_000

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SlackFetch = (url: string, init: any) => Promise<Response>

export class SlackApiError extends Error {
  readonly code: string
  constructor(method: string, code: string) {
    super(`slack ${method}: ${code}`)
    this.name = 'SlackApiError'
    this.code = code
  }
}

export type SlackResult = { ok: boolean; error?: string } & Record<string, unknown>

let fetchImpl: SlackFetch = (url, init) => fetch(url, init)
/** Tests only. */
export function setSlackFetch(f: SlackFetch | null): void {
  fetchImpl = f ?? ((url, init) => fetch(url, init))
}

async function call(method: string, init: { headers: Record<string, string>; body: string }): Promise<SlackResult> {
  let res: Response
  try {
    res = await fetchImpl(`${SLACK_API}${method}`, { method: 'POST', ...init, redirect: 'error', signal: AbortSignal.timeout(SLACK_TIMEOUT_MS) })
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    throw new SlackApiError(method, name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network_error')
  }
  if (!res.ok) throw new SlackApiError(method, `http_${res.status}`)
  let data: SlackResult
  try {
    data = (await res.json()) as SlackResult
  } catch {
    throw new SlackApiError(method, 'bad_json')
  }
  if (!data || data.ok !== true) throw new SlackApiError(method, typeof data?.error === 'string' ? data.error : 'not_ok')
  return data
}

/** A bot-token method with a JSON body. */
export function slackApi(method: string, token: string, body: Record<string, unknown>): Promise<SlackResult> {
  return call(method, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) })
}

/** A bot-token method that only takes form arguments (conversations.list). */
export function slackApiForm(method: string, token: string, args: Record<string, string>): Promise<SlackResult> {
  return call(method, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(args).toString() })
}

export interface OAuthAccess {
  team_id: string
  team_name: string | null
  bot_user_id: string
  access_token: string
  scope: string | null
  installed_by: string | null
}

/** oauth.v2.access: exchange the code (client id + secret as HTTP Basic). */
export async function oauthAccess(code: string, redirectUri: string, clientId: string, clientSecret: string): Promise<OAuthAccess> {
  const data = await call('oauth.v2.access', {
    headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, redirect_uri: redirectUri }).toString(),
  })
  const team = (data.team ?? {}) as { id?: string; name?: string }
  const user = (data.authed_user ?? {}) as { id?: string }
  if (data.token_type !== 'bot' || typeof data.access_token !== 'string' || typeof data.bot_user_id !== 'string' || !team.id) {
    throw new SlackApiError('oauth.v2.access', 'no_bot_token')
  }
  return {
    team_id: team.id,
    team_name: team.name ?? null,
    bot_user_id: data.bot_user_id,
    access_token: data.access_token,
    scope: typeof data.scope === 'string' ? data.scope : null,
    installed_by: user.id ?? null,
  }
}

export interface SlackChannel {
  id: string
  name: string
  is_private: boolean
  is_member: boolean
}

/** Public and private channels the bot can see (private ones only once it was invited). Capped at 1000. */
export async function listChannels(token: string): Promise<SlackChannel[]> {
  const out: SlackChannel[] = []
  let cursor = ''
  for (let page = 0; page < 5; page++) {
    const args: Record<string, string> = { types: 'public_channel,private_channel', exclude_archived: 'true', limit: '200' }
    if (cursor) args.cursor = cursor
    const data = await slackApiForm('conversations.list', token, args)
    for (const c of (data.channels ?? []) as { id?: string; name?: string; is_private?: boolean; is_member?: boolean }[]) {
      if (c.id && c.name) out.push({ id: c.id, name: c.name, is_private: !!c.is_private, is_member: !!c.is_member })
    }
    cursor = ((data.response_metadata ?? {}) as { next_cursor?: string }).next_cursor ?? ''
    if (!cursor) break
  }
  return out
}
