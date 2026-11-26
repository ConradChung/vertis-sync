import { esc, type Block } from '@/lib/slack/card'

/**
 * GTM-14 #sales cards (pure): a PM who commented on Frank's LinkedIn post,
 * and one weekly digest per post of its PM reactors. Every card hands over
 * text to copy; nothing is ever sent from here (footer says so).
 *
 *  - Everything from LinkedIn, the crawl and the drafts is untrusted: escaped
 *    with esc(), links only for well-formed http(s) URLs, drafts inside code
 *    blocks (so they copy cleanly and cannot format the post).
 *  - buildSignalCard refuses a row the crawl did not confirm as a property
 *    manager or (segment owner_operator) an owner-operator: second guard
 *    against vendors after the edge fn. Owner-operators are labelled.
 *  - Drafts: DM if connected; connection note if not; one message after
 *    they accept; then the Kaspen line + demo ask, after they reply.
 *  - Decided states: approved keeps the drafts visible, skipped collapses.
 */

export const SIGNAL_ACTION_IDS = { approve: 'signal_approve', edit: 'signal_edit', skip: 'signal_skip' } as const
export const SIGNAL_EDIT_CALLBACK_ID = 'signal_edit'
export const SIGNAL_DRAFT_FIELDS = ['dm', 'connection_note', 'followup_dm', 'after_reply'] as const
export type SignalDraftField = (typeof SIGNAL_DRAFT_FIELDS)[number]
/** The drafts JSON: the editable texts plus what they were built from (opening, question, source). */
export type SignalDrafts = Partial<Record<SignalDraftField | 'opening' | 'question' | 'source', string | null>>
export const SIGNAL_EDIT_INPUT_ID = 'value'
export const signalEditBlockId = (f: SignalDraftField) => `signal_${f}`
export const SIGNAL_DRAFT_MAX = 3000
export const SLACK_BLOCK_LIMIT = 50
export const DIGEST_MAX_PEOPLE = 8
export const FOOTER = "Nothing is sent automatically. Copy and send from Frank's LinkedIn."
export const REACTOR_OPENING_PLACEHOLDER = '✏️ write the reactor opening line (signal_config.reactor_opening)'

export interface SignalContact {
  name?: string | null
  title?: string | null
  linkedin_url?: string | null
  /** The person's own verified work email (Blitz, signal contacts stage). Old Apollo rows have none. */
  email?: string | null
}

/** The signal_people columns the cards read. */
export interface SignalPersonRow {
  id: number
  kind: 'commenter' | 'reactor'
  stage: string
  linkedin_url: string
  name: string | null
  headline?: string | null
  title: string | null
  company_name: string | null
  company_website: string | null
  location: string | null
  post_id: string | null
  comment_text: string | null
  comment_url: string | null
  commented_at: string | null
  /** 'pm' (management company) or 'owner_operator' (owns and self-manages rentals). */
  segment?: 'pm' | 'owner_operator' | null
  crawl_verdict: string | null
  door_count: number | null
  door_count_source: string | null
  door_count_confidence: 'high' | 'medium' | 'low' | null
  contacts: unknown
  connected: boolean | null
  drafts: SignalDrafts | null
  alert_status: 'dry_run' | 'posted' | 'approved' | 'edited' | 'skipped' | null
  decided_by: string | null
  decided_at: string | null
}

export interface SignalPostRow {
  post_id: string
  post_url: string
  posted_at: string
  text_excerpt: string | null
}

export interface SignalCardOpts {
  premium: boolean
  noteLimit: number
  /** False until Connections.csv was loaded: `connected` is then treated as unknown. */
  connectionsLoaded: boolean
  now?: Date
  /** The post the comment is on (for the post link). */
  post?: Pick<SignalPostRow, 'post_url'> | null
}

export interface SignalDigestOpts extends SignalCardOpts {
  reactorOpening: string | null
}

// ── helpers ──────────────────────────────────────────────────────────────

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** An http(s) URL safe to put inside <url|label> (no <, >, |, spaces). */
export function safeUrl(u: unknown): string | null {
  if (typeof u !== 'string') return null
  let s = u.trim()
  if (!s) return null
  if (!/^https?:\/\//i.test(s)) {
    if (/^[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i.test(s)) s = `https://${s}`
    else return null
  }
  if (/[<>|\s"]/.test(s)) return null
  try {
    const url = new URL(s)
    return url.protocol === 'http:' || url.protocol === 'https:' ? s : null
  } catch {
    return null
  }
}

const link = (url: unknown, label: string) => {
  const u = safeUrl(url)
  return u ? `<${u}|${esc(label)}>` : esc(label)
}

/** A Slack user mention, only for a well-formed id. */
export const who = (id: string | null | undefined) => (id && /^[UW][A-Z0-9]{2,30}$/.test(id) ? `<@${id}>` : 'someone')

export function relTime(iso: string | null | undefined, now: Date): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  const mins = Math.max(0, Math.round((now.getTime() - t) / 60_000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** A draft as a copyable code block. Escaped; a ``` inside cannot close the block. */
export function codeBlock(s: string): string {
  return '```' + esc(clip(s.trim(), 2800)).replace(/```/g, 'ʼʼʼ') + '```'
}

function doorsText(r: SignalPersonRow): string {
  if (typeof r.door_count !== 'number' || !Number.isFinite(r.door_count) || r.door_count <= 0) return '*Doors:* unknown'
  const bits: string[] = []
  if (r.door_count_confidence) bits.push(`${r.door_count_confidence} confidence`)
  const src = text(r.door_count_source)
  if (src) bits.push(safeUrl(src) ? link(src, 'source') : `via ${esc(clip(oneLine(src), 80))}`)
  return `*Doors:* ~${r.door_count.toLocaleString('en-US')}${bits.length ? ` (${bits.join(' · ')})` : ''}`
}

const EMAIL = /^[^\s@<>|]+@[^\s@<>|]+\.[^\s@<>|]+$/

/** The work email found for this person, or null. Only an entry carrying an email counts (old Apollo contacts never did). */
export function signalPersonEmail(r: Pick<SignalPersonRow, 'contacts'>): string | null {
  if (!Array.isArray(r.contacts)) return null
  for (const c of r.contacts as SignalContact[]) {
    const e = typeof c?.email === 'string' ? c.email.trim() : ''
    if (EMAIL.test(e)) return e
  }
  return null
}

const emailText = (e: string) => `*Email:* ${esc(e)}` // Slack links an address by itself

function headline(r: SignalPersonRow): string {
  const name = text(r.name) ?? 'Unknown name'
  const parts = [`*${link(r.linkedin_url, clip(oneLine(name), 120))}*`]
  const title = text(r.title) ?? text(r.headline)
  if (title) parts.push(esc(clip(oneLine(title), 150)))
  const company = text(r.company_name)
  if (company) parts.push(link(r.company_website, clip(oneLine(company), 120)))
  else if (safeUrl(r.company_website)) parts.push(link(r.company_website, 'website'))
  return parts.join(' · ')
}

export const isOwnerOperator = (r: Pick<SignalPersonRow, 'segment'>) => r.segment === 'owner_operator'

/** A crawl-confirmed PM, or a crawl-confirmed owner-operator (segment and verdict both say so). */
export function crawlPassed(r: Pick<SignalPersonRow, 'crawl_verdict' | 'segment'>): boolean {
  return r.crawl_verdict === 'property_manager' || (isOwnerOperator(r) && r.crawl_verdict === 'owner_operator')
}

/** Refuse anything the crawl did not confirm. */
export function assertPropertyManager(r: Pick<SignalPersonRow, 'id' | 'crawl_verdict' | 'segment'>): void {
  if (!crawlPassed(r)) {
    throw new Error(`signal card refused: person ${r.id} crawl_verdict is ${r.crawl_verdict ?? 'null'}, not property_manager`)
  }
}

/** Who they are, for the header and fallback. */
const kindLabel = (r: Pick<SignalPersonRow, 'segment'>) => (isOwnerOperator(r) ? 'Owner-operator' : 'PM')
export const OWNER_OPERATOR_NOTE = '🏠 *owner-operator*: owns and self-manages rentals, not a management company'

/** The draft versions that apply, labelled, in send order. */
export function draftSections(r: Pick<SignalPersonRow, 'connected' | 'drafts'>, opts: SignalCardOpts): { label: string; body: string | null }[] {
  const d = r.drafts ?? {}
  const connected = opts.connectionsLoaded ? r.connected : null
  const note = text(d.connection_note)
  const noteLabel = `connection note (${note ? note.length : 0}/${opts.noteLimit} chars)${note && note.length > opts.noteLimit ? ' ⚠️ over the limit' : ''}`
  const dm = { label: connected === true ? "You're connected → DM" : "If you're connected → DM", body: text(d.dm) }
  const notConnected = [
    { label: connected === false ? `Not connected → ${noteLabel}` : `If not connected → ${noteLabel}`, body: note },
    { label: 'After they accept', body: text(d.followup_dm) },
  ]
  const afterReply = { label: 'After they reply (either way) → Kaspen + demo', body: text(d.after_reply) }
  if (connected === true) return [dm, afterReply]
  if (connected === false) return [...notConnected, afterReply]
  return [dm, ...notConnected, afterReply]
}

const renderDraft = (s: { label: string; body: string | null }) => `*${s.label}*\n${s.body ? codeBlock(s.body) : '_(no draft)_'}`

function buttons(id: number): Block {
  const value = String(id)
  return {
    type: 'actions',
    block_id: 'signal_decide',
    elements: [
      { type: 'button', action_id: SIGNAL_ACTION_IDS.approve, style: 'primary', value, text: { type: 'plain_text', text: 'Approve' } },
      { type: 'button', action_id: SIGNAL_ACTION_IDS.edit, value, text: { type: 'plain_text', text: 'Edit' } },
      { type: 'button', action_id: SIGNAL_ACTION_IDS.skip, style: 'danger', value, text: { type: 'plain_text', text: 'Skip' } },
    ],
  }
}

const context = (t: string): Block => ({ type: 'context', elements: [{ type: 'mrkdwn', text: t }] })
const section = (t: string): Block => ({ type: 'section', text: { type: 'mrkdwn', text: clip(t, 3000) } })

/** Plain one-line fallback (notifications). */
export function signalFallbackText(r: Pick<SignalPersonRow, 'name' | 'company_name' | 'segment'>): string {
  const name = text(r.name) ? oneLine(r.name!) : 'Someone'
  const company = text(r.company_name) ? ` (${oneLine(r.company_name!)})` : ''
  return esc(clip(`${kindLabel(r)} commented on Frank's post: ${name}${company}`, 200))
}

// ── commenter card ───────────────────────────────────────────────────────

export function buildSignalCard(row: SignalPersonRow, opts: SignalCardOpts): { text: string; blocks: Block[] } {
  assertPropertyManager(row)
  const now = opts.now ?? new Date()
  const fallback = signalFallbackText(row)

  if (row.alert_status === 'skipped') {
    return {
      text: fallback,
      blocks: [section(`~${headline(row)}~`), context(`:no_entry_sign: Skipped by ${who(row.decided_by)}. Nothing was sent.`)],
    }
  }

  const blocks: Block[] = [{ type: 'header', text: { type: 'plain_text', text: `💬 ${kindLabel(row)} commented on Frank's post`, emoji: true } }, section(headline(row))]
  if (isOwnerOperator(row)) blocks.push(context(OWNER_OPERATOR_NOTE))

  const facts = [doorsText(row)]
  const loc = text(row.location)
  facts.push(`*Location:* ${loc ? esc(clip(oneLine(loc), 150)) : 'unknown'}`)
  const email = signalPersonEmail(row)
  if (email) facts.push(emailText(email))
  blocks.push({ type: 'section', fields: facts.map((t) => ({ type: 'mrkdwn', text: t })) })

  const comment = text(row.comment_text)
  const links = [row.comment_url && safeUrl(row.comment_url) ? link(row.comment_url, 'comment') : null, opts.post?.post_url && safeUrl(opts.post.post_url) ? link(opts.post.post_url, 'post') : null].filter(Boolean)
  const when = relTime(row.commented_at, now)
  const meta = [links.join(' · '), when].filter(Boolean).join(' · ')
  blocks.push(section(`*Commented on Frank's post:*${meta ? ` ${meta}` : ''}\n${comment ? `>${esc(clip(comment, 700)).replace(/\n/g, '\n>')}` : '_(no comment text)_'}`))

  blocks.push({ type: 'divider' })
  const drafts = draftSections(row, opts)
  if (drafts.length > 1) blocks.push(context("Not sure if Frank is connected: use the version that applies."))
  for (const d of drafts) blocks.push(section(renderDraft(d)))

  if (row.alert_status === 'approved') {
    blocks.push(context(`:white_check_mark: Approved by ${who(row.decided_by)}. Copy and send from Frank's LinkedIn.`))
  } else {
    if (row.alert_status === 'edited') blocks.push(context(`:pencil2: Drafts edited by ${who(row.decided_by)}.`))
    blocks.push(buttons(row.id))
  }
  blocks.push(context(FOOTER))
  return { text: fallback, blocks }
}

// ── reactor digest ───────────────────────────────────────────────────────

function packSections(parts: string[]): Block[] {
  const out: string[] = []
  for (const p of parts) {
    const last = out.length - 1
    if (last >= 0 && out[last].length + p.length + 2 <= 2900) out[last] += `\n\n${p}`
    else out.push(p)
  }
  return out.map(section)
}

function reactorBlocks(r: SignalPersonRow, opts: SignalCardOpts): Block[] {
  const info = [headline(r), doorsText(r)]
  const loc = text(r.location)
  if (loc) info.push(`*Location:* ${esc(clip(oneLine(loc), 100))}`)
  const email = signalPersonEmail(r)
  if (email) info.push(emailText(email))
  if (isOwnerOperator(r)) info.push(OWNER_OPERATOR_NOTE)
  return packSections([info.join('\n'), ...draftSections(r, opts).map(renderDraft)])
}

export function buildSignalDigest(post: SignalPostRow, reactors: SignalPersonRow[], opts: SignalDigestOpts): { text: string; blocks: Block[]; shown: number[] } {
  const now = opts.now ?? new Date()
  const pms = reactors.filter(crawlPassed)
  const head: Block[] = [{ type: 'header', text: { type: 'plain_text', text: `👍 ${pms.length} PM${pms.length === 1 ? '' : 's'} reacted to Frank's post`, emoji: true } }]
  const excerpt = text(post.text_excerpt)
  const when = relTime(post.posted_at, now)
  head.push(section(`${excerpt ? `>${esc(clip(oneLine(excerpt), 300))}\n` : ''}${link(post.post_url, 'Open the post')}${when ? ` · posted ${when}` : ''}`))
  head.push(
    section(
      opts.reactorOpening
        ? `*Opening line (start each message with it):*\n${codeBlock(opts.reactorOpening)}`
        : `*Opening line:* ${REACTOR_OPENING_PLACEHOLDER}`
    )
  )
  head.push({ type: 'divider' })
  const tail: Block[] = [context(FOOTER)]

  const body: Block[] = []
  const shown: number[] = []
  for (const r of pms) {
    if (shown.length >= DIGEST_MAX_PEOPLE) break
    const rb = reactorBlocks(r, opts)
    // Keep one block free for the "+N more" line.
    if (head.length + body.length + rb.length + 1 + tail.length + 1 > SLACK_BLOCK_LIMIT) break
    body.push(...rb, { type: 'divider' })
    shown.push(r.id)
  }
  if (body.length && body[body.length - 1].type === 'divider') body.pop()
  const more = pms.length - shown.length
  if (more > 0) body.push(context(`+${more} more PM reactor${more === 1 ? '' : 's'} (see Lume).`))
  return { text: esc(clip(`${pms.length} PM${pms.length === 1 ? '' : 's'} reacted to Frank's post`, 200)), blocks: [...head, ...body, ...tail], shown }
}

// ── edit modal ───────────────────────────────────────────────────────────

const FIELD_LABEL: Record<SignalDraftField, string> = {
  dm: 'DM (if connected)',
  connection_note: 'Connection note (if not connected)',
  followup_dm: 'After they accept',
  after_reply: 'After they reply (Kaspen + demo)',
}

export function buildSignalEditModal(row: Pick<SignalPersonRow, 'id' | 'drafts'>, noteLimit?: number): Block {
  const d = row.drafts ?? {}
  return {
    type: 'modal',
    callback_id: SIGNAL_EDIT_CALLBACK_ID,
    private_metadata: String(row.id),
    title: { type: 'plain_text', text: 'Edit drafts' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: SIGNAL_DRAFT_FIELDS.map((f) => {
      const v = text(d[f])
      const max = f === 'connection_note' && noteLimit ? noteLimit : SIGNAL_DRAFT_MAX
      return {
        type: 'input',
        block_id: signalEditBlockId(f),
        optional: true,
        label: { type: 'plain_text', text: FIELD_LABEL[f] },
        element: { type: 'plain_text_input', action_id: SIGNAL_EDIT_INPUT_ID, multiline: true, max_length: max, ...(v ? { initial_value: clip(v, max) } : {}) },
      }
    }),
  }
}

/** Synchronous modal validation (shown under the field). Null = fine. */
export function signalEditErrors(drafts: SignalDrafts, noteLimit: number): Record<string, string> | null {
  const errors: Record<string, string> = {}
  for (const f of SIGNAL_DRAFT_FIELDS) {
    const v = drafts[f]
    if (v && v.length > SIGNAL_DRAFT_MAX) errors[signalEditBlockId(f)] = `Keep it under ${SIGNAL_DRAFT_MAX} characters.`
  }
  const note = drafts.connection_note
  if (note && note.trim().length > noteLimit) errors[signalEditBlockId('connection_note')] = `LinkedIn allows ${noteLimit} characters in a note (this is ${note.trim().length}).`
  return Object.keys(errors).length ? errors : null
}

// ── plain-text preview (dry run) ─────────────────────────────────────────

function mrkdwnToText(s: string): string {
  return s
    .replace(/<(https?:[^|>]+)\|([^>]*)>/g, '$2 ($1)')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

type TextObj = { text?: unknown }
const blockText = (t: unknown) => (t && typeof (t as TextObj).text === 'string' ? mrkdwnToText((t as TextObj).text as string) : '')

export function renderCardAsText(blocks: unknown): string {
  const lines: string[] = []
  for (const b of Array.isArray(blocks) ? (blocks as Record<string, unknown>[]) : []) {
    switch (b?.type) {
      case 'header':
        lines.push(`# ${blockText(b.text)}`)
        break
      case 'section':
        if (b.text) lines.push(blockText(b.text))
        if (Array.isArray(b.fields)) lines.push((b.fields as unknown[]).map(blockText).join('   |   '))
        break
      case 'context':
        lines.push((Array.isArray(b.elements) ? (b.elements as unknown[]) : []).map(blockText).join(' ').replace(/^/gm, '  '))
        break
      case 'divider':
        lines.push('—'.repeat(30))
        break
      case 'actions':
        lines.push((Array.isArray(b.elements) ? (b.elements as Record<string, unknown>[]) : []).map((e) => `[${blockText(e.text)}]`).join(' '))
        break
    }
  }
  return lines.join('\n')
}
