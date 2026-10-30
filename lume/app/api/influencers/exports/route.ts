import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody } from '@/lib/http/json'
import { APOLLO_IMPORT_STEPS, exportColumns, influencerApolloCsv, LAST_RUN } from '@/lib/influencers/model'
import { ExportBody } from '@/lib/influencers/schemas'
import { createExport, exportCandidates, influencerNames } from '@/lib/influencers/store'

/**
 * `POST /api/influencers/exports` `{ min_door_count?, only_new?, verified_only?
 * (default true), run_id?, influencer_slugs?, door_count_column?,
 * reacted_to_column? }` → 201 `{ export_id, rows, download, columns, preview,
 * steps }`; 422 nothing_to_export. Records the export and marks its reactors
 * exported (only_new skips them next time). The CSV is
 * `GET /api/influencers/exports/<id>`. Nothing goes to Apollo.
 */
export async function POST(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const body = await parseJsonBody(req, ExportBody, 8 * 1024)
  if (!body.ok) return body.response
  const filters = { verified_only: true, ...body.data }
  try {
    const rows = await exportCandidates(filters)
    if (!rows.length) return NextResponse.json({ error: 'nothing_to_export', filters }, { status: 422 })
    const created = await createExport(filters, rows.map((r) => Number(r.id)))
    const names = await influencerNames()
    const opts = { names, doorCount: !!filters.door_count_column, reactedTo: !!filters.reacted_to_column }
    const preview = influencerApolloCsv(rows.slice(0, 5), opts).csv
    return NextResponse.json(
      {
        export_id: created.id,
        rows: rows.length,
        with_door_count: rows.filter((r) => r.door_count !== null).length,
        at_700_plus: rows.filter((r) => (r.door_count ?? 0) >= 700).length,
        download: `/api/influencers/exports/${created.id}`,
        columns: exportColumns(opts),
        preview,
        filters,
        steps: APOLLO_IMPORT_STEPS,
        benchmark_note: `Last full run: ${LAST_RUN.verified} verified, ${LAST_RUN.leads_700} at 700+ doors.`,
      },
      { status: 201 }
    )
  } catch (err) {
    return dbErrorResponse(err, 'api/influencers/exports')
  }
}
