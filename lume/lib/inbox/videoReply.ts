/**
 * The Kaspen "video yes" auto-reply. Step 1 of the live Kaspen campaigns ends
 * on "Open to seeing a 2-min video of how it dispatches work orders?". A lead
 * who answers with a plain yes gets the link back, sent with nobody tapping:
 * the owner granted exactly this (2026-11-12) and nothing wider.
 *
 * The grant (lib/actions/grant.ts evaluateGrant) approves a send_reply only
 * when its body IS this template for the lead, on one of these campaigns, to
 * the lead's first reply, which must be a plain yes. Anything else (a
 * question, a condition, a second message) waits for a person as before. The
 * executor re-runs the same check against a fresh read before sending. Pure.
 */
import { looksLikeOptOut } from '@/lib/inbox/replyMode'

/** Kaspen — Americas, UK, Middle East, APAC (Instantly ids). */
export const VIDEO_REPLY_CAMPAIGNS: ReadonlySet<string> = new Set([
  'bcf7a6d2-1302-47fc-ae77-9d2a760c91c1',
  '25c80373-b5c1-4b46-bb47-2faf37c8bd1e',
  '39e42e38-aec6-4ce2-8f15-bc4753a9f914',
  '11698b94-59b5-4a0b-8447-c2465efd7bc0',
])

export const VIDEO_REPLY_DRAFTED_BY = 'Lume (video yes)'

/** The pause between the lead's email arriving and the reply going out. */
export const VIDEO_REPLY_DELAY_MS = 3 * 60_000

const firstNameOf = (leadName: string | null | undefined) => {
  const first = (leadName ?? '').trim().split(/\s+/)[0] ?? ''
  return /^[\p{L}][\p{L}'’.-]{0,40}$/u.test(first) ? first : null
}

/** The reply, for the lead's name and company as the server looked them up. */
export function videoReplyBody(leadName: string | null | undefined, company: string | null | undefined): string {
  const first = firstNameOf(leadName)
  const co = (company ?? '').trim()
  const whose = co && co.length <= 80 ? `${co}'s` : 'your team’s'
  return [
    first ? `Hi ${first},` : 'Hi there,',
    '',
    'Here you go: https://kaspen.ai. The 2-min video is right at the top. If you’d rather test it yourself, hit "Talk to Kaspen" on the same page and call it as a tenant or owner.',
    '',
    `Want a free 15-min audit of where ${whose} ops time goes?`,
    '',
    'Frank',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// "A plain yes"

/** Every word of the yes must come from here… */
const YES_VOCAB = new Set(
  (
    'yes yeah yea yep yup ya sure ok okay k absolutely definitely certainly interested please pls plz send it over ' +
    'that the video link me a look love would i id i’d i\'d be great good sounds sound perfect happy to go ahead ' +
    'do thanks thank you ty thx cheers much hi hey hello frank there of course why not thing appreciated appreciate ' +
    'keen let’s lets let\'s see share sounds see it definitely'
  ).split(/\s+/)
)
/** …and at least one of these must be there. */
const AFFIRM = /\b(yes|yeah|yea|yep|yup|ya|sure|ok|okay|k|absolutely|definitely|certainly|interested|please|pls|plz|send|love|great|perfect|happy|keen|go ahead|of course|why not|sounds good|let'?s see|see it)\b/

/** Mobile footers that are not part of what the lead said. */
const FOOTER = /^(sent from my \w+|get outlook for \w+|sent from (yahoo|mail|gmail|outlook)\b.*|--+|__+)$/i

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)

/**
 * The lead's whole (quote-trimmed) message is a plain yes: the first paragraph
 * is only yes-words (≤ 12), nothing anywhere asks a question or opts out, and
 * whatever follows looks like a sign-off (a few short lines). False whenever
 * in doubt: a person then approves the reply, as before.
 */
export function isPlainYes(text: string | null | undefined): boolean {
  const t = (text ?? '').replace(/\r\n?/g, '\n').trim()
  if (!t || t.length > 400 || t.includes('?') || looksLikeOptOut(t)) return false
  const paras = t.split(/\n\s*\n/)
  const head = paras[0].trim()
  const w = words(head)
  if (w.length === 0 || w.length > 12) return false
  if (!w.every((x) => YES_VOCAB.has(x) || YES_VOCAB.has(x.replace(/'/g, '’')))) return false
  if (!AFFIRM.test(w.join(' '))) return false
  // The rest: a signature at most (name, title, company, phone), nothing said.
  const rest = paras
    .slice(1)
    .join('\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !FOOTER.test(l))
  if (rest.length > 6) return false
  return rest.every((l) => l.length <= 60 && words(l).length <= 6 && !/[.!]$/.test(l.replace(/\b(inc|ltd|llc|co|corp)\.$/i, '')))
}

export type VideoBlocker = 'video_not_campaign' | 'video_not_template' | 'video_not_plain_yes' | 'video_not_first_reply' | 'video_not_asked'

/** The step-1 question the yes must answer (other variants close on the audit offer). */
export const VIDEO_QUESTION = /2-min video of how it dispatches work orders\?/i

/**
 * Did our last email before the answered one ask the video question? Reads
 * the thread's outbound emails (quotes untrimmed: our own text is the body).
 */
export function askedVideo(
  thread: readonly { id: string; direction: 'in' | 'out'; text: string; created_at: string | null; at: string | null }[],
  answeredId: string
): boolean {
  const when = (e: { created_at: string | null; at: string | null }) => e.created_at ?? e.at ?? ''
  const answered = thread.find((e) => e.id === answeredId)
  if (!answered) return false
  const before = thread.filter((e) => e.direction === 'out' && when(e) <= when(answered)).sort((a, b) => when(a).localeCompare(when(b)))
  const last = before[before.length - 1]
  return !!last && VIDEO_QUESTION.test(last.text.replace(/\s+/g, ' '))
}

/** Is this send_reply the video reply (so the video grant, not Auto mode, judges it)? */
export function isVideoReplyPayload(p: Record<string, unknown>): boolean {
  return p.drafted_by === VIDEO_REPLY_DRAFTED_BY
}

/**
 * The video-specific half of the grant; grant.ts adds the shared checks
 * (verified campaign and recipient, opt-out, labels, interest).
 */
export function videoBlocker(c: {
  payload: Record<string, unknown>
  /** Quote-trimmed full text of the answered email. */
  message: string
  /** This lead's lume_replies rows, any campaign. */
  leadReplies: readonly { reply_to_uuid?: string | null }[]
  /** askedVideo() over the answered email's thread. */
  asked: boolean
}): VideoBlocker | null {
  const p = c.payload
  if (typeof p.campaign_id !== 'string' || !VIDEO_REPLY_CAMPAIGNS.has(p.campaign_id)) return 'video_not_campaign'
  const name = typeof p.lead_name === 'string' ? p.lead_name : null
  const company = typeof p.company === 'string' ? p.company : null
  if (p.body !== videoReplyBody(name, company)) return 'video_not_template'
  if (!c.asked) return 'video_not_asked'
  if (!isPlainYes(c.message)) return 'video_not_plain_yes'
  if (c.leadReplies.some((r) => r.reply_to_uuid && r.reply_to_uuid !== p.reply_to_uuid)) return 'video_not_first_reply'
  return null
}
