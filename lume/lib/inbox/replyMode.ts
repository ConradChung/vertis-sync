import type { Json } from '@/lib/db/types'

/**
 * Per-campaign reply approval mode (inbox manager 3e; design doc "Client
 * Slack agent"). Pure.
 *
 *  - owner (default): the owner, /operator or a Grok Bot approves each
 *    send_reply (a bot never its own draft: lib/operators/policy.ts).
 *  - client: the client approves in Slack, or the owner (3g). Until the
 *    Slack app exists it behaves exactly like owner.
 *  - auto: the scoped send grant. A send_reply for the campaign is approved
 *    at creation with decided_via='grant', unless `grantBlocker` finds a
 *    reason to hold it for a person. The executor still runs every live
 *    re-check, and re-checks the grant itself right before sending.
 *
 * send_reply stays in ALWAYS_ASK_KINDS: skip mode never sends a reply. The
 * grant is the only path that approves one with nobody tapping.
 */

export const REPLY_MODES = ['owner', 'client', 'auto'] as const
export type ReplyMode = (typeof REPLY_MODES)[number]

export const parseReplyMode = (v: unknown): ReplyMode => ((REPLY_MODES as readonly unknown[]).includes(v) ? (v as ReplyMode) : 'owner')

/**
 * The lead asked to stop, or was hostile, or does not want this. Deliberately
 * broad: a false positive only means a person approves the reply, as in owner
 * mode. Covers English plus common German, French and Spanish opt-outs.
 */
const OPT_OUT = new RegExp(
  [
    String.raw`\b(unsubscribe|unsub|remove|take me off|stop (e-?mailing|contacting|sending|messaging)|(do not|don'?t|never) (contact|e-?mail|message|write)|opt(ed)?[- ]?out|not interested|no,? thanks|no,? thank you|not for us|wrong person|leave me alone)\b`,
    String.raw`\b(spam(ming)?|scam|report(ing)? (you|this)|harass\w*|lawyer|legal action|fu+ck\w*|shit|bullshit|piss off|go away)\b`,
    String.raw`\bf\*{2,}`,
    // German, French, Spanish / Portuguese
    String.raw`\b(abmelden|abbestellen|austragen)\b`,
    String.raw`(d[ée]sabonner|d[ée]sinscri(re|vez|s)|d[ée]sabonnement)`,
    String.raw`\b(darme de baja|dar de baja|de baja|baja|cancelar|cancele|descadastrar)\b`,
  ].join('|'),
  'i'
)

/** A short message that says "stop" anywhere is an opt-out (a bare "STOP" included). */
const SHORT_STOP_CHARS = 280
const STOP = /\bstop\b/i

export function looksLikeOptOut(text: string | null | undefined): boolean {
  if (!text) return false
  const t = text.trim()
  return OPT_OUT.test(t) || (t.length <= SHORT_STOP_CHARS && STOP.test(t))
}

/** Labels (lume_replies.handled_how) that close a lead for good: never auto-send to them again. */
export const NEGATIVE_LABELS: ReadonlySet<string> = new Set(['label:bad_fit', 'label:unsubscribe', 'label:hostile', 'label:not_interested'])

export type GrantBlocker =
  | 'mode_owner'
  | 'mode_client'
  | 'no_campaign'
  | 'campaign_unverified'
  | 'campaign_mismatch'
  | 'verdict_bad'
  | 'verdict_not_good'
  | 'recipient_unverified'
  | 'no_lead_message'
  | 'opt_out_or_hostile'
  | 'reply_labeled'
  | 'negative_interest'
  | 'out_of_office'
  | 'reply_unrecorded'
  | 'lead_labeled_negative'

export interface GrantContext {
  mode: ReplyMode
  /** The send_reply payload (as filed, server-built). */
  payload: Record<string, Json | undefined>
  /**
   * The answered email as Instantly has it: its FULL quote-trimmed text (not
   * the card's 2000-character cut), interest and campaign. Null when it could
   * not be read.
   */
  email: { message: string; interest: number | null; campaign_id: string | null } | null
  /** lume_replies row for the email being answered, if recorded. */
  reply: { handled_how: string | null; interest: number | null } | null
  /** Every lume_replies row of this lead, in ANY campaign. */
  leadReplies: readonly { handled_how: string | null }[]
}

/**
 * Why an Auto-mode campaign's reply must still wait for a person, or null
 * when the grant may approve it. Auto approves only a verdict of GOOD
 * (UNSURE follows the SOP's UNSURE rule, which a person applies; a missing
 * verdict is unscored) on a campaign the email itself named, to a verified
 * recipient. Never for BAD; an unsubscribe, stop, hostile or "no thanks"
 * message (full text); an out-of-office or negative interest; an unknown
 * interest with no recorded reply; or a lead an earlier label closed in any
 * campaign.
 */
export function grantBlocker(c: GrantContext): GrantBlocker | null {
  if (c.mode !== 'auto') return c.mode === 'client' ? 'mode_client' : 'mode_owner'
  const p = c.payload
  if (typeof p.campaign_id !== 'string' || !p.campaign_id) return 'no_campaign'
  if (p.campaign_verified !== true) return 'campaign_unverified'
  if (p.verdict === 'BAD') return 'verdict_bad'
  if (p.verdict !== 'GOOD') return 'verdict_not_good'
  if (p.recipient_verified === false) return 'recipient_unverified'
  const card = typeof p.their_message === 'string' ? p.their_message.trim() : ''
  const full = c.email?.message.trim() ?? ''
  if (!c.email || !full) return 'no_lead_message'
  if (looksLikeOptOut(full) || looksLikeOptOut(card)) return 'opt_out_or_hostile'
  if (c.email.campaign_id !== p.campaign_id) return 'campaign_mismatch'
  if (c.reply?.handled_how?.startsWith('label:')) return 'reply_labeled'
  const interest = c.email.interest ?? c.reply?.interest ?? null
  if (interest === null && !c.reply) return 'reply_unrecorded'
  if (interest === 0) return 'out_of_office'
  if (typeof interest === 'number' && interest < 0) return 'negative_interest'
  if (c.leadReplies.some((r) => r.handled_how !== null && NEGATIVE_LABELS.has(r.handled_how))) return 'lead_labeled_negative'
  return null
}

/** Short human text for a blocker (feed notes, the reply card). */
export const GRANT_BLOCKER_TEXT: Record<GrantBlocker, string> = {
  mode_owner: 'the campaign is in Owner mode',
  mode_client: 'the campaign is in Client mode (client approval arrives with the Slack app; the owner approves until then)',
  no_campaign: 'the reply has no campaign',
  campaign_unverified: "the campaign was not confirmed from the lead's email",
  campaign_mismatch: "the reply's campaign is not the answered email's campaign",
  verdict_bad: 'the verdict is BAD',
  verdict_not_good: 'Auto mode sends only replies with a verdict of GOOD',
  recipient_unverified: 'the recipient could not be verified',
  no_lead_message: "the lead's message could not be read",
  opt_out_or_hostile: 'the lead may have asked to stop, said no thanks, or was hostile',
  reply_labeled: 'the reply was already labeled',
  negative_interest: 'Instantly marks the reply as not interested',
  out_of_office: 'Instantly marks the reply as out of office',
  reply_unrecorded: 'the reply has no interest status and was never recorded as positive',
  lead_labeled_negative: 'the lead was labeled BAD, unsubscribe, hostile or not interested before (any campaign)',
}
