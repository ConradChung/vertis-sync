import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody, uuidParam } from '@/lib/http/json'
import { deleteItems, isSortable, MISSING, pageItems, removeWhere } from '@/lib/leads/lists/store'
import { AppendSource } from '@/lib/leads/lists/sources'
import { appendFromSource, sourceErrorResponse, withList, type ListCtx } from '@/lib/leads/lists/service'

/**
 *  GET    ?page&page_size&q&sort&dir → `{ rows, total, page, page_size }`.
 *  POST   `{ source, conversation_id? }` → append with dedupe → the append report
 *         (added, duplicates, skipped, over_cap, line). Inline / pasted rows are
 *         tagged 'agent' for the bearer, 'manual' for the owner's page.
 *  DELETE `{ idxs }` or `{ missing: ['email'|...], q }` → `{ removed }`.
 */
export const maxDuration = 120

const Post = z.object({ source: AppendSource, conversation_id: z.string().uuid().nullable().optional(), project_id: z.string().uuid().nullable().optional() })
const Delete = z
  .object({ idxs: z.array(z.number().int().min(0)).max(20_000).optional(), missing: z.array(z.enum(MISSING)).max(4).optional(), q: z.string().max(120).optional() })
  .refine((v) => !!v.idxs?.length || !!v.missing?.length || !!v.q?.trim(), 'idxs, missing or q')

export async function GET(req: Request, ctx: ListCtx) {
  try {
    const auth = await requireOwner(req)
    if (!auth.ok) return auth.response
    const r = await withList(ctx)
    if (!r.ok) return r.response
    const sp = new URL(req.url).searchParams
    const page = Math.max(0, Number(sp.get('page')) || 0)
    const pageSize = Math.min(200, Math.max(1, Number(sp.get('page_size')) || 100))
    const raw = sp.get('sort') ?? 'idx'
    const sort = raw === 'idx' || isSortable(raw) ? raw : 'idx'
    // The list's cached row count stands in for an exact count when there is no search.
    const out = await pageItems(r.list.id, { page, pageSize, q: sp.get('q') ?? undefined, sort, dir: sp.get('dir') === 'desc' ? 'desc' : 'asc', knownTotal: r.list.item_count })
    return NextResponse.json({ ...out, page, page_size: pageSize })
  } catch (err) {
    return dbErrorResponse(err, 'api/lead-lists/[id]/items')
  }
}

export async function POST(req: Request, ctx: ListCtx) {
  try {
    const auth = await requireOwner(req)
    if (!auth.ok) return auth.response
    const body = await parseJsonBody(req, Post, 2_100_000)
    if (!body.ok) return body.response
    const r = await withList(ctx)
    if (!r.ok) return r.response
    const conversationId = body.data.conversation_id ? uuidParam(body.data.conversation_id) : null
    const projectId = body.data.project_id ? uuidParam(body.data.project_id) : null
    const report = await appendFromSource(r.list, body.data.source, { conversationId, projectId, by: auth.via === 'internal' ? 'agent' : 'owner' })
    return NextResponse.json(report)
  } catch (err) {
    return sourceErrorResponse(err) ?? dbErrorResponse(err, 'api/lead-lists/[id]/items')
  }
}

export async function DELETE(req: Request, ctx: ListCtx) {
  try {
    const auth = await requireOwner(req)
    if (!auth.ok) return auth.response
    const body = await parseJsonBody(req, Delete, 256 * 1024)
    if (!body.ok) return body.response
    const r = await withList(ctx)
    if (!r.ok) return r.response
    let removed = 0
    if (body.data.idxs?.length) removed += await deleteItems(r.list.id, body.data.idxs)
    if (body.data.missing?.length || body.data.q?.trim()) removed += await removeWhere(r.list.id, { missing: body.data.missing, q: body.data.q })
    return NextResponse.json({ removed })
  } catch (err) {
    return dbErrorResponse(err, 'api/lead-lists/[id]/items')
  }
}
