import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { fileInConversation, getChatFile, loadParsed } from '@/lib/agent/chatFiles'
import { CANDIDATE_FIELDS, candidateColumnMapping, estimateLookup, planCandidates, UnknownCandidateColumnError } from '@/lib/influencers/candidates'
import { createCandidateBatch, existingInfluencerNames, listCandidateBatches } from '@/lib/influencers/candidateStore'
import { createInfluencerSheet, sheetsForBatches } from '@/lib/leads/lists/influencerSheets'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody } from '@/lib/http/json'
import { pickSheet } from '@/lib/sheets/model'

/**
 * Influencer candidates (owner, or the agent's bearer).
 *  GET  → `{ batches }` newest first, each with its per-status counts.
 *  POST `{ file_id, sheet?, columns?, name?, conversation_id? }` → stage one
 *       sheet of an attached spreadsheet as candidates (status pending_lookup;
 *       a name already among influencers is only noted, possible_duplicate_of;
 *       repeats in the list, same name and company, are 'duplicate'). Nothing is
 *       spent: the lookup is a separate, owner-approved `influencer_lookup`
 *       action. With `conversation_id` the file must belong to that chat.
 *       → 201 `{ batch, staged, to_look_up, duplicates, skipped_no_name,
 *       column_mapping, unmapped_columns, sheet, estimate }`.
 */
export const maxDuration = 60

const MAX_ROWS = 5000

const Body = z
  .object({
    file_id: z.string().uuid(),
    sheet: z.string().min(1).max(200).optional(),
    columns: z.partialRecord(z.enum(CANDIDATE_FIELDS), z.string().max(200)).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    conversation_id: z.string().uuid().nullable().optional(),
  })
  .strict()

export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  try {
    const batches = await listCandidateBatches()
    const sheets = await sheetsForBatches(batches.map((b) => b.id))
    return NextResponse.json({ batches: batches.map((b) => ({ ...b, list_id: sheets.get(b.id) ?? null })) })
  } catch (err) {
    return dbErrorResponse(err, 'api/influencers/candidates')
  }
}

export async function POST(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const body = await parseJsonBody(req, Body, 4096)
  if (!body.ok) return body.response
  const fileId = body.data.file_id.toLowerCase()
  const conversationId = body.data.conversation_id?.toLowerCase() ?? null
  try {
    if (conversationId && !(await fileInConversation(fileId, conversationId))) return NextResponse.json({ error: 'file_not_found' }, { status: 404 })
    const file = await getChatFile(fileId)
    const wb = file ? await loadParsed(fileId) : null
    if (!file || !wb) return NextResponse.json({ error: 'file_not_found' }, { status: 404 })
    const sheet = pickSheet(wb.sheets, body.data.sheet)
    if (!sheet) return NextResponse.json({ error: 'sheet_not_found', sheets: wb.sheets.map((s) => s.name) }, { status: 404 })
    if (sheet.rows.length > MAX_ROWS) return NextResponse.json({ error: 'too_many_rows', max: MAX_ROWS }, { status: 413 })
    let mapped
    try {
      mapped = candidateColumnMapping(sheet.header, body.data.columns ?? {})
    } catch (err) {
      if (err instanceof UnknownCandidateColumnError) return NextResponse.json({ error: err.detail, header: sheet.header }, { status: 400 })
      throw err
    }
    const plan = planCandidates(sheet.header, sheet.rows, mapped.mapping, await existingInfluencerNames())
    if (!plan.rows.length) return NextResponse.json({ error: 'no_named_rows' }, { status: 422 })
    const batch = await createCandidateBatch(
      { name: (body.data.name ?? `${file.name} · ${sheet.name}`).slice(0, 200), source_file_id: fileId, source_sheet: sheet.name, conversation_id: conversationId },
      plan.rows
    )
    // The batch is a sheet in Leads (its chat's project folder, else Influencers).
    const sheetList = await createInfluencerSheet(batch, plan.rows.length, conversationId)
    return NextResponse.json(
      {
        batch,
        list_id: sheetList.id,
        href: `/import/leads?list=${sheetList.id}`,
        staged: plan.rows.length,
        to_look_up: plan.to_look_up,
        duplicates: plan.rows.length - plan.to_look_up,
        possible_duplicates: plan.possible_duplicates,
        skipped_no_name: plan.skipped_no_name,
        column_mapping: mapped.mapping,
        unmapped_columns: mapped.unmapped,
        sheet: sheet.name,
        estimate: estimateLookup(plan.to_look_up),
      },
      { status: 201 }
    )
  } catch (err) {
    return dbErrorResponse(err, 'api/influencers/candidates')
  }
}
