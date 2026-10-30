/**
 * Pure helpers for the Agent tab: SSE frame parsing for `/api/agent/run` and
 * replaying earlier turns as real turns for `/api/agent/run`.
 */

import type { ChatImageRef, ImageMediaType } from '@/lib/agent/images'

export type AgentEvent = Record<string, unknown> & { type: string }

/** Split a buffered SSE stream into parsed `data:` events and the unfinished tail. */
export function parseSseFrames(buffer: string): { events: AgentEvent[]; rest: string } {
  const events: AgentEvent[] = []
  let rest = buffer
  let idx: number
  while ((idx = rest.indexOf('\n\n')) >= 0) {
    const frame = rest.slice(0, idx)
    rest = rest.slice(idx + 2)
    const line = frame.split('\n').find((l) => l.startsWith('data: '))
    if (!line) continue
    try {
      const e = JSON.parse(line.slice(6)) as unknown
      if (e && typeof e === 'object' && typeof (e as AgentEvent).type === 'string') events.push(e as AgentEvent)
    } catch {
      // malformed frame: skip
    }
  }
  return { events, rest }
}

export interface ContextTurn {
  role: 'user' | 'assistant'
  text: string
  /** Images the owner attached to this turn (references; the bytes live in Storage). */
  images?: ChatImageRef[]
}

/** `/api/agent/run` caps one owner message (pasted drafts, threads) at this many chars. */
export const MESSAGE_MAX = 50_000
/** Earlier turns sent with each run (~75k tokens); newest kept, oldest dropped. */
export const HISTORY_MAX_CHARS = 300_000
/** One stored turn longer than this is cut (so one giant paste can't push out the rest). */
export const TURN_MAX_CHARS = 40_000

/** Earlier images replayed to Claude: those of the newest few owner turns that carry any... */
export const HISTORY_IMAGE_TURNS = 3
/** ...and at most this many in all (older ones become "[image omitted: <name>]"). */
export const HISTORY_IMAGE_MAX = 5

/** Raw image bytes per run (current + replayed), well under the API's 32 MB request cap once base64'd. */
export const RUN_IMAGE_BYTES = 18 * 1024 * 1024

/** An image ready for Claude: its reference plus the base64 bytes. */
export interface LoadedImage extends ChatImageRef {
  data: string
}

type TextBlock = { type: 'text'; text: string }
type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: ImageMediaType; data: string } }

export interface ChatTurnParam {
  role: 'user' | 'assistant'
  content: (TextBlock | ImageBlock)[]
}

const OMITTED = '[Earlier turns of this conversation were omitted for length.]'

/**
 * The history images worth replaying: newest first, from the last
 * HISTORY_IMAGE_TURNS owner turns that have any, at most HISTORY_IMAGE_MAX.
 * The route loads exactly these; buildMessages notes every other one.
 */
export function selectReplayImages(history: ContextTurn[]): ChatImageRef[] {
  const out: ChatImageRef[] = []
  let turns = 0
  // Only turns buildMessages keeps: an image in a turn dropped for length is never loaded.
  const { from } = keptTurns(history)
  for (let i = history.length - 1; i >= from && turns < HISTORY_IMAGE_TURNS; i--) {
    const t = history[i]
    if (t.role !== 'user' || !t.images?.length) continue
    turns++
    for (const img of t.images) {
      if (out.length >= HISTORY_IMAGE_MAX) return out
      out.push(img)
    }
  }
  return out
}

const rawBytes = (img: LoadedImage) => Math.floor((img.data.length * 3) / 4)

/**
 * The replayed images that fit beside the current ones within `cap` raw
 * bytes. `replay` is newest first (selectReplayImages' order); the oldest go
 * first, so what is kept is the newest run that fits. The current message's
 * images always stay (≤ 5 × 2 MB, under the cap on their own).
 */
export function fitImageBudget(current: LoadedImage[], replay: LoadedImage[], cap = RUN_IMAGE_BYTES): LoadedImage[] {
  let left = cap - current.reduce((n, img) => n + rawBytes(img), 0)
  const kept: LoadedImage[] = []
  for (const img of replay) {
    left -= rawBytes(img)
    if (left < 0) break
    kept.push(img)
  }
  return kept
}

const truncate = (raw: string) => (raw.length > TURN_MAX_CHARS ? `${raw.slice(0, TURN_MAX_CHARS)}\n… [truncated ${raw.length - TURN_MAX_CHARS} chars]` : raw)
const omittedNote = (r: ChatImageRef) => `[image omitted: ${r.name}]`

/**
 * Which stored turns fit the char budget, newest first: `from` is the oldest
 * index kept. Each turn is charged its (truncated) text plus a note for every
 * image as if omitted, so the answer does not depend on which images load.
 */
function keptTurns(history: ContextTurn[]): { from: number; omitted: boolean } {
  let budget = HISTORY_MAX_CHARS
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i]
    const refs = turn.role === 'user' ? (turn.images ?? []) : []
    const raw = turn.text.trim()
    if (!raw && !refs.length) continue
    const cost = joinText(refs.map(omittedNote).join('\n'), truncate(raw)).length
    if (cost > budget) return { from: i + 1, omitted: true }
    budget -= cost
  }
  return { from: 0, omitted: false }
}

export interface BuildOptions {
  /** The images attached to the current message, in order. */
  current?: LoadedImage[]
  /** History images that were loaded, by path (from selectReplayImages); any other is noted, not sent. */
  loaded?: Map<string, LoadedImage>
}

interface Turn {
  role: 'user' | 'assistant'
  text: string
  images: LoadedImage[]
}

const imageBlock = (img: LoadedImage): ImageBlock => ({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } })
const joinText = (a: string, b: string) => (a && b ? `${a}\n\n${b}` : a || b)

/**
 * The route is stateless (one run per prompt), so the conversation's stored
 * turns are replayed as real user/assistant turns ahead of the current
 * message, in full up to TURN_MAX_CHARS each and HISTORY_MAX_CHARS in total
 * (newest win). Roles strictly alternate and start with the owner: same-role
 * neighbours merge, a leading assistant turn is dropped, and an unanswered
 * owner turn folds into the current message.
 *
 * Images: a turn's images come first, then its text (as Claude recommends).
 * The current message's images are always sent; a history image is sent only
 * when `loaded` has it, otherwise the turn's text opens with
 * "[image omitted: <name>]". Images do not count toward the char budget, but
 * a turn dropped for length takes its images with it.
 */
export function buildMessages(history: ContextTurn[], message: string, opts: BuildOptions = {}): ChatTurnParam[] {
  const current = message.trim()
  const loaded = opts.loaded ?? new Map<string, LoadedImage>()
  const kept: Turn[] = []
  const { from, omitted: dropped } = keptTurns(history)
  let omitted = dropped
  for (let i = from; i < history.length; i++) {
    const turn = history[i]
    const refs = turn.role === 'user' ? (turn.images ?? []) : []
    const raw = turn.text.trim()
    if (!raw && !refs.length) continue
    const images: LoadedImage[] = []
    const notes: string[] = []
    for (const r of refs) {
      const img = loaded.get(r.path)
      if (img) images.push(img)
      else notes.push(omittedNote(r))
    }
    kept.push({ role: turn.role, text: joinText(notes.join('\n'), truncate(raw)), images })
  }
  const merged: Turn[] = []
  for (const t of kept) {
    const last = merged[merged.length - 1]
    if (last && last.role === t.role) {
      last.text = joinText(last.text, t.text)
      last.images = [...last.images, ...t.images]
    } else merged.push({ ...t, images: [...t.images] })
  }
  while (merged.length && merged[0].role === 'assistant') {
    merged.shift()
    omitted = true
  }
  let tail: Turn = { role: 'user', text: current, images: opts.current ?? [] }
  if (merged.length && merged[merged.length - 1].role === 'user') {
    const prev = merged.pop()!
    tail = { role: 'user', text: joinText(prev.text, current), images: [...prev.images, ...tail.images] }
  }
  const turns: Turn[] = [...merged, tail]
  if (omitted) turns[0] = { ...turns[0], text: joinText(OMITTED, turns[0].text) }
  return turns.map((t) => ({
    role: t.role,
    content: [...t.images.map(imageBlock), ...(t.text ? [{ type: 'text' as const, text: t.text }] : [])],
  }))
}
