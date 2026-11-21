import { z } from 'zod'
import { McpUserError } from './sanitize'

export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 200

/** Shared pagination inputs: cursor-based, newest first. */
export const pageInput = {
  limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Rows to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
  cursor: z.string().max(200).optional().describe('Pass next_cursor from the previous page.'),
}

type Cursor = { t: string; id: string }

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/
const ID = /^[A-Za-z0-9-]{1,64}$/

export function encodeCursor(t: string, id: string | number): string {
  return Buffer.from(JSON.stringify({ t, id: String(id) })).toString('base64url')
}

/**
 * Decodes and validates a cursor. Both fields are pattern-checked because
 * they are interpolated into a PostgREST `or` filter.
 */
export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor
    if (typeof c.t === 'string' && typeof c.id === 'string' && ISO.test(c.t) && ID.test(c.id)) return c
  } catch {
    /* fall through */
  }
  throw new McpUserError('Invalid cursor. Start again without one.')
}

/** PostgREST filter for "older than the cursor" on (time desc, id desc). */
export function olderThan(c: Cursor, timeCol = 'created_at', idCol = 'id'): string {
  return `${timeCol}.lt.${c.t},and(${timeCol}.eq.${c.t},${idCol}.lt.${c.id})`
}

/** Splits a fetched `limit + 1` batch into the page and the next cursor. */
export function pageOf<T extends Record<string, unknown>>(
  rows: T[],
  limit: number,
  timeCol = 'created_at',
  idCol = 'id',
): { rows: T[]; next_cursor: string | null } {
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  const next = rows.length > limit && last ? encodeCursor(String(last[timeCol]), String(last[idCol])) : null
  return { rows: page, next_cursor: next }
}
