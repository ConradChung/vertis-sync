import 'server-only'
import { NextResponse } from 'next/server'
import { ApifyError } from '@/lib/adapters/apify'
import { getProject, listProjects } from '@/lib/agent/projects'
import { SourceError } from '@/lib/apollo/source'
import { uuidParam } from '@/lib/http/json'
import { createServiceClient } from '@/lib/supabase/service'
import { appendItems, getList, ListBusy, listLists, projectDefaultList, type AppendResult, type LeadList } from '@/lib/leads/lists/store'
import { rowsFromSource, SourceRefused, type AppendSource } from '@/lib/leads/lists/sources'

export type ListCtx = { params: Promise<{ id: string }> }

/** The deep link the chat's "Open in Leads" button and the page use. */
export const leadsHref = (listId: string) => `/import/leads?list=${listId}`

/** An existing list from the route params, or the error response (call after the owner guard). */
export async function withList(ctx: ListCtx): Promise<{ ok: true; list: LeadList } | { ok: false; response: NextResponse }> {
  const id = uuidParam((await ctx.params).id)
  if (!id) return { ok: false, response: NextResponse.json({ error: 'invalid_id' }, { status: 400 }) }
  const list = await getList(id)
  if (!list) return { ok: false, response: NextResponse.json({ error: 'not_found' }, { status: 404 }) }
  return { ok: true, list }
}

/** A source failure as its HTTP answer, or null when it is not one. */
export function sourceErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof SourceRefused || err instanceof SourceError) return NextResponse.json({ error: err.code }, { status: err.status })
  if (err instanceof ListBusy) return NextResponse.json({ error: 'list_busy' }, { status: 409 })
  if (err instanceof ApifyError) return NextResponse.json({ error: `apify_${err.code}` }, { status: err.code === 'not_found' ? 404 : err.code === 'not_configured' ? 503 : 502 })
  return null
}

export interface AppendReport extends AppendResult {
  list_id: string
  name: string
  href: string
  /** "added 12, 3 duplicates skipped → PM owners" */
  line: string
  mapping?: unknown
  unmapped?: string[]
}

export function appendLine(r: AppendResult, name: string): string {
  const extra = [r.skipped ? `${r.skipped} without an email, LinkedIn or name + company` : '', r.over_cap ? `${r.over_cap} over the 20,000-row cap` : ''].filter(Boolean)
  return `added ${r.added}, ${r.duplicates} duplicate${r.duplicates === 1 ? '' : 's'} skipped${extra.length ? `, ${extra.join(', ')}` : ''} → ${name}`
}

export async function appendFromSource(list: LeadList, src: AppendSource, ctx: { conversationId?: string | null; projectId?: string | null; by: 'agent' | 'owner' }): Promise<AppendReport> {
  const { rows, mapping, unmapped } = await rowsFromSource(src, ctx)
  const r = await appendItems(list.id, rows)
  return { ...r, list_id: list.id, name: list.name, href: leadsHref(list.id), line: appendLine(r, list.name), ...(mapping ? { mapping, unmapped } : {}) }
}

/** Leads produced in a project's chat go to that project's default list (created the first time). null: no live project. */
export async function autoAppendToProject(projectId: string, src: AppendSource, ctx: { conversationId?: string | null }): Promise<AppendReport | null> {
  const project = await getProject(projectId)
  if (!project) return null
  const list = await projectDefaultList(project.id, project.name)
  return appendFromSource(list, src, { ...ctx, projectId: project.id, by: 'agent' })
}

export interface Folder {
  id: string | null
  name: string
  lists: (LeadList & { sent_job_id: string | null })[]
}

/** The Leads page's tree: live projects (in their order) with their lists, then Unfiled. */
export async function folderTree(): Promise<Folder[]> {
  const [projects, lists] = await Promise.all([listProjects(), listLists()])
  const ingestIds = lists.map((l) => l.sent_ingest_id).filter((v): v is string => !!v)
  const jobs = new Map<string, string | null>()
  if (ingestIds.length) {
    const { data, error } = await createServiceClient().from('telegram_ingests').select('id,validation_job_id').in('id', ingestIds)
    if (error) throw error
    for (const r of data ?? []) jobs.set(r.id as string, (r.validation_job_id as string | null) ?? null)
  }
  const withJob = (l: LeadList) => ({ ...l, sent_job_id: l.sent_ingest_id ? (jobs.get(l.sent_ingest_id) ?? null) : null })
  const live = new Set(projects.map((p) => p.id))
  const folders: Folder[] = projects.map((p) => ({ id: p.id, name: p.name, lists: lists.filter((l) => l.project_id === p.id).map(withJob) }))
  folders.push({ id: null, name: 'Unfiled', lists: lists.filter((l) => !l.project_id || !live.has(l.project_id)).map(withJob) })
  return folders
}
