import 'server-only'
import type { Json } from '@/lib/db/types'
import { createServiceClient } from '@/lib/supabase/service'
import { combineSheets, COMBINE_MAX_INPUT_ROWS, type CombineKey, type CombineResult, type OverlayRule } from '@/lib/leads/combine'
import { planFinal, type FinalFilter, type FinalPlan } from '@/lib/leads/finalFilter'
import { appendItems, createList, deleteList, getList, type AppendResult, type LeadList, type ListRow } from '@/lib/leads/lists/store'
import { LIST_MAX_ITEMS } from '@/lib/leads/lists/model'
import type { Cells } from '@/lib/leads/columns'

/**
 * GTM-18 sheet moves on stored lists (server only; owner routes in front):
 *
 *  - Combine (step 2): read the chosen lists, overlay them on a key
 *    (lib/leads/combine.ts) and save the result as a new "combined master"
 *    list whose rows sit at `2 · Combined`, each keeping where it came from.
 *  - Filter → Final (step 3): run a saved filter (lib/leads/finalFilter.ts)
 *    over a list, save a new "final sheet" with every row at `3 · Filtered`
 *    (the dropped ones excluded, with their reason), and move the source
 *    rows' status forward to 3 as well, so the master shows how far each got.
 *
 * Both only write Lume's own lead list rows: nothing is sent, pushed or paid.
 * `preview` runs the same planning and writes nothing.
 */

const db = () => createServiceClient()
const PAGE = 1000

export class StageRefused extends Error {
  constructor(
    public code: string,
    public status = 400
  ) {
    super(code)
    this.name = 'StageRefused'
  }
}

type Stored = { idx: number; item: ListRow['item']; cells: Cells | null; status?: string | null; pipeline_step?: number | null }

/** Every row of a list in idx order, up to `cap` rows (StageRefused past it). */
export async function readAllRows(listId: string, cap: number, opts: { keptOnly?: boolean } = {}): Promise<Stored[]> {
  const out: Stored[] = []
  for (let from = 0; ; from += PAGE) {
    let q = db().from('lead_review_items').select('idx,item,cells,status,pipeline_step').eq('set_id', listId)
    if (opts.keptOnly) q = q.neq('status', 'excluded')
    const { data, error } = await q.order('idx', { ascending: true }).range(from, from + PAGE - 1)
    if (error) throw error
    const page = (data ?? []) as unknown as Stored[]
    out.push(...page)
    if (out.length > cap) throw new StageRefused('too_many_rows', 413)
    if (page.length < PAGE) return out
  }
}

async function liveLeadLists(ids: readonly string[]): Promise<LeadList[]> {
  const lists = await Promise.all(ids.map((id) => getList(id)))
  if (lists.some((l) => !l)) throw new StageRefused('list_not_found', 404)
  const found = lists as LeadList[]
  if (found.some((l) => l.sheet_kind !== 'leads')) throw new StageRefused('influencer_sheet', 409)
  return found
}

export interface CombineInput {
  list_ids: string[]
  key: CombineKey
  rule: OverlayRule
}

export interface CombinePreview {
  stats: CombineResult['stats']
  columns: string[]
  sample: { key: string | null; cells: Cells; sources: number; conflicts: string[] }[]
}

async function planCombine(input: CombineInput): Promise<{ lists: LeadList[]; result: CombineResult }> {
  if (new Set(input.list_ids).size !== input.list_ids.length) throw new StageRefused('duplicate_list')
  if (input.rule.kind === 'prefer' && !input.list_ids.includes(input.rule.sheet_id)) throw new StageRefused('prefer_not_in_lists')
  const lists = await liveLeadLists(input.list_ids)
  let budget = COMBINE_MAX_INPUT_ROWS
  const sheets = []
  for (const l of lists) {
    // Excluded rows are dropouts: they don't come along into a new master.
    const rows = await readAllRows(l.id, budget, { keptOnly: true })
    budget -= rows.length
    sheets.push({ id: l.id, name: l.name, rows: rows.map((r) => ({ idx: r.idx, item: r.item, cells: r.cells ?? {} })) })
  }
  const result = combineSheets(sheets, { key: input.key, rule: input.rule })
  // A list holds at most LIST_MAX_ITEMS rows; a bigger master would be cut short, so it is refused (preview too).
  if (result.rows.length > LIST_MAX_ITEMS) throw new StageRefused('over_list_cap', 413)
  return { lists, result }
}

/** Fill a just-made list; if that fails, the half-filled list is deleted so no stray master or final sheet is left behind. */
async function fillOrDelete(listId: string, rows: Parameters<typeof appendItems>[1]): Promise<AppendResult> {
  try {
    return await appendItems(listId, rows)
  } catch (e) {
    await deleteList(listId).catch(() => false)
    throw e
  }
}

export async function previewCombine(input: CombineInput, sampleSize = 20): Promise<CombinePreview> {
  const { result } = await planCombine(input)
  return {
    stats: result.stats,
    columns: result.columns,
    sample: result.rows.slice(0, sampleSize).map((r) => ({ key: r.key, cells: r.cells, sources: r.sources.length, conflicts: r.conflicts })),
  }
}

export async function combineLists(
  input: CombineInput & { name: string; project_id?: string | null; created_by: 'owner' | 'agent' }
): Promise<{ list: LeadList; stats: CombineResult['stats']; append: AppendResult }> {
  const { lists, result } = await planCombine(input)
  const list = await createList({
    name: input.name,
    created_by: input.created_by,
    project_id: input.project_id ?? null,
    notes: `Combined from ${lists.map((l) => l.name).join(' + ')} on ${input.key === 'auto' ? 'domain for companies, email for people' : input.key}.`,
    sheet_stage: 'combined',
    source_list_ids: lists.map((l) => l.id),
    stage_spec: { key: input.key, rule: input.rule, stats: result.stats } as unknown as Json,
  })
  const names = new Map(lists.map((l) => [l.id, l.name]))
  const append = await fillOrDelete(
    list.id,
    result.rows.map((r) => ({
      // The audit: which sheet rows this master row came from, and the columns that disagreed.
      raw: { combined_from: r.sources.map((s) => ({ list_id: s.sheet_id, list: names.get(s.sheet_id) ?? null, row: s.idx + 1 })), conflicts: r.conflicts },
      item: r.item,
      cells: r.cells,
      source: 'review_set' as const,
      step: 2 as const,
    }))
  )
  return { list: (await getList(list.id)) ?? list, stats: result.stats, append }
}

export interface FinalPreview {
  kept: number
  excluded: number
  reasons: FinalPlan['reasons']
}

async function planFromList(listId: string, filter: FinalFilter): Promise<{ list: LeadList; rows: Stored[]; plan: FinalPlan }> {
  const [list] = await liveLeadLists([listId])
  const rows = await readAllRows(list.id, COMBINE_MAX_INPUT_ROWS, { keptOnly: true })
  return { list, rows, plan: planFinal(rows.map((r) => ({ idx: r.idx, item: r.item })), filter) }
}

export async function previewFinal(listId: string, filter: FinalFilter): Promise<FinalPreview> {
  const { plan } = await planFromList(listId, filter)
  return { kept: plan.kept, excluded: plan.excluded, reasons: plan.reasons }
}

export async function makeFinal(
  listId: string,
  input: { name: string; filter: FinalFilter; created_by: 'owner' | 'agent' }
): Promise<{ list: LeadList; kept: number; excluded: number; reasons: FinalPlan['reasons']; append: AppendResult }> {
  const { list: source, rows, plan } = await planFromList(listId, input.filter)
  if (plan.kept === 0) throw new StageRefused('nothing_kept', 422)
  const final = await createList({
    name: input.name,
    created_by: input.created_by,
    project_id: source.project_id,
    notes: `Final sheet filtered from ${source.name}: ${plan.kept} kept, ${plan.excluded} excluded.`,
    sheet_stage: 'final',
    source_list_ids: [source.id],
    stage_spec: { filter: input.filter, kept: plan.kept, excluded: plan.excluded, reasons: plan.reasons } as unknown as Json,
  })
  const outcome = new Map(plan.rows.map((o) => [o.idx, o]))
  // Kept rows first, so the final sheet reads top-down as the campaign list; the excluded follow with their reasons.
  const ordered = [...rows].sort((a, b) => Number(!outcome.get(a.idx)!.kept) - Number(!outcome.get(b.idx)!.kept) || a.idx - b.idx)
  const append = await fillOrDelete(
    final.id,
    ordered.map((r) => {
      const o = outcome.get(r.idx)!
      return {
        raw: { filtered_from: { list_id: source.id, list: source.name, row: r.idx + 1 } },
        item: r.item,
        cells: r.cells ?? {},
        source: 'review_set' as const,
        step: 3 as const,
        step_note: o.note,
        status: o.kept ? ('kept' as const) : ('excluded' as const),
      }
    })
  )
  await advanceSource(source.id, plan)
  return { list: (await getList(final.id)) ?? final, kept: plan.kept, excluded: plan.excluded, reasons: plan.reasons, append }
}

/**
 * The source rows reached step 3 too: move their step forward (never back).
 * Only the step: the reason a row dropped lives on the final sheet, since
 * another filter run over the same master may drop it for another reason.
 */
async function advanceSource(listId: string, plan: FinalPlan): Promise<void> {
  const idxs = plan.rows.map((o) => o.idx)
  for (let i = 0; i < idxs.length; i += 500) {
    const { error } = await db()
      .from('lead_review_items')
      .update({ pipeline_step: 3 })
      .eq('set_id', listId)
      .in('idx', idxs.slice(i, i + 500))
      .lt('pipeline_step', 3)
    if (error) throw error
  }
}
