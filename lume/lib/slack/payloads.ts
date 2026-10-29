import { ACTION_IDS, EDIT_BLOCK_ID, EDIT_CALLBACK_ID, EDIT_INPUT_ID } from '@/lib/slack/card'

/**
 * Parse Slack's (already signature-verified) event and interaction bodies
 * into the few shapes Lume acts on (3g). Pure. Anything else, or anything
 * with a malformed id, is null and ignored.
 */

const TEAM = /^[TE][A-Z0-9]{2,30}$/
const USER = /^[UW][A-Z0-9]{2,30}$/
const CHANNEL = /^[CGD][A-Z0-9]{2,30}$/
const TS = /^\d{1,12}\.\d{1,8}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const match = (re: RegExp, v: unknown): string | null => (typeof v === 'string' && re.test(v) ? v : null)

export type SlackEvent =
  | { kind: 'url_verification'; challenge: string }
  | { kind: 'app_mention'; team: string; channel: string; user: string; text: string; ts: string; thread_ts: string | null }
  | { kind: 'revoke'; team: string; reason: 'app_uninstalled' | 'tokens_revoked' }
  | null

export function parseEvent(raw: string): SlackEvent {
  let body: Obj
  try {
    body = obj(JSON.parse(raw))
  } catch {
    return null
  }
  if (body.type === 'url_verification') {
    const challenge = str(body.challenge)
    return challenge && challenge.length <= 200 ? { kind: 'url_verification', challenge } : null
  }
  if (body.type !== 'event_callback') return null
  const team = match(TEAM, body.team_id)
  const ev = obj(body.event)
  if (!team) return null
  if (ev.type === 'app_uninstalled') return { kind: 'revoke', team, reason: 'app_uninstalled' }
  if (ev.type === 'tokens_revoked') {
    const bot = obj(ev.tokens).bot
    return Array.isArray(bot) && bot.length > 0 ? { kind: 'revoke', team, reason: 'tokens_revoked' } : null
  }
  if (ev.type === 'app_mention') {
    if (ev.bot_id || ev.subtype) return null
    const channel = match(CHANNEL, ev.channel)
    const user = match(USER, ev.user)
    const ts = match(TS, ev.ts)
    const text = str(ev.text)
    if (!channel || !user || !ts || text === null) return null
    return { kind: 'app_mention', team, channel, user, text: text.slice(0, 4000), ts, thread_ts: match(TS, ev.thread_ts) }
  }
  return null
}

export type SlackInteraction =
  | { kind: 'button'; decision: 'approve' | 'edit' | 'skip'; team: string; user: string; channel: string; message_ts: string; action_id: string; trigger_id: string }
  | { kind: 'edit_submit'; team: string; user: string; post_id: number; body: string }
  | null

export const EDIT_MAX_CHARS = 3000

/** The form body `payload=<json>` of an interaction. */
export function parseInteraction(rawForm: string): SlackInteraction {
  let p: Obj
  try {
    p = obj(JSON.parse(new URLSearchParams(rawForm).get('payload') ?? ''))
  } catch {
    return null
  }
  const team = match(TEAM, obj(p.team).id)
  const user = match(USER, obj(p.user).id)
  if (!team || !user) return null
  if (p.type === 'block_actions') {
    const a = obj(Array.isArray(p.actions) ? p.actions[0] : null)
    const decision = a.action_id === ACTION_IDS.approve ? 'approve' : a.action_id === ACTION_IDS.edit ? 'edit' : a.action_id === ACTION_IDS.skip ? 'skip' : null
    const container = obj(p.container)
    const channel = match(CHANNEL, container.channel_id) ?? match(CHANNEL, obj(p.channel).id)
    const message_ts = match(TS, container.message_ts) ?? match(TS, obj(p.message).ts)
    const action_id = match(UUID, a.value)
    const trigger_id = str(p.trigger_id) ?? ''
    if (!decision || !channel || !message_ts || !action_id) return null
    return { kind: 'button', decision, team, user, channel, message_ts, action_id, trigger_id }
  }
  if (p.type === 'view_submission') {
    const view = obj(p.view)
    if (view.callback_id !== EDIT_CALLBACK_ID) return null
    const postId = Number(view.private_metadata)
    const body = str(obj(obj(obj(obj(view.state).values)[EDIT_BLOCK_ID])[EDIT_INPUT_ID]).value)
    if (!Number.isSafeInteger(postId) || postId <= 0 || body === null) return null
    return { kind: 'edit_submit', team, user, post_id: postId, body }
  }
  return null
}

/** The modal's validation answer, synchronous (Slack shows it under the field). Null = fine. */
export function editBodyError(body: string): string | null {
  if (!body.trim()) return 'The reply cannot be empty.'
  if (body.length > EDIT_MAX_CHARS) return `Keep it under ${EDIT_MAX_CHARS} characters.`
  return null
}
