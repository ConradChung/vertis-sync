import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody } from '@/lib/http/json'
import { getProject } from '@/lib/agent/projects'
import { COMBINE_MAX_SHEETS } from '@/lib/leads/combine'
import { leadsHref, sourceErrorResponse } from '@/lib/leads/lists/service'
import { combineLists, previewCombine, StageRefused } from '@/lib/leads/lists/stages'

/**
 * Step 2 · Combined (GTM-18). POST `{ list_ids, key, rule, prefer_list_id?, name?, project_id?, preview? }`:
 *  - `preview: true` → `{ stats, columns, sample }` (nothing written);
 *  - otherwise → 201 `{ list, href, stats, append }`: a new combined master list.
 * key: 'auto' (domain, then email) | 'domain' | 'email'. rule: 'fill_blanks'
 * (a filled cell is never overwritten) | 'prefer' (prefer_list_id's values win).
 * Only Lume's own list rows are written.
 */
export const maxDuration = 120

const Body = z
  .object({
    list_ids: z.array(z.string().uuid()).min(2).max(COMBINE_MAX_SHEETS),
    key: z.enum(['auto', 'domain', 'email']).default('auto'),
    rule: z.enum(['fill_blanks', 'prefer']).default('fill_blanks'),
    prefer_list_id: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(200).optional(),
    project_id: z.string().uuid().nullable().optional(),
    preview: z.boolean().optional(),
  })
  .refine((b) => b.rule !== 'prefer' || !!b.prefer_list_id, { message: 'prefer_list_id is required with rule prefer', path: ['prefer_list_id'] })
  .refine((b) => b.preview || !!b.name, { message: 'name is required', path: ['name'] })

function stageErrorResponse(err: unknown): NextResponse | null {
  return err instanceof StageRefused ? NextResponse.json({ error: err.code }, { status: err.status }) : null
}

export async function POST(req: Request) {
  try {
    const auth = await requireOwner(req)
    if (!auth.ok) return auth.response
    const body = await parseJsonBody(req, Body, 16 * 1024)
    if (!body.ok) return body.response
    const b = body.data
    const input = {
      list_ids: b.list_ids.map((x) => x.toLowerCase()),
      key: b.key,
      rule: b.rule === 'prefer' ? ({ kind: 'prefer', sheet_id: b.prefer_list_id!.toLowerCase() } as const) : ({ kind: 'fill_blanks' } as const),
    }
    if (b.preview) return NextResponse.json(await previewCombine(input))
    const projectId = b.project_id?.toLowerCase() ?? null
    if (projectId && !(await getProject(projectId))) return NextResponse.json({ error: 'folder_not_found' }, { status: 404 })
    const out = await combineLists({ ...input, name: b.name!, project_id: projectId, created_by: auth.via === 'internal' ? 'agent' : 'owner' })
    return NextResponse.json({ ...out, href: leadsHref(out.list.id) }, { status: 201 })
  } catch (err) {
    return stageErrorResponse(err) ?? sourceErrorResponse(err) ?? dbErrorResponse(err, 'api/lead-lists/combine')
  }
}
