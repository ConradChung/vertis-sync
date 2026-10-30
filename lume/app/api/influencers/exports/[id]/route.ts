import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { uuidParam } from '@/lib/http/json'
import { influencerApolloCsv } from '@/lib/influencers/model'
import { exportRows, getExport, influencerNames } from '@/lib/influencers/store'

/**
 * `GET /api/influencers/exports/<id>` — that export as an Apollo
 * contact-import CSV (download): First Name, Last Name, Title, Company,
 * Website (company domain), Person Linkedin Url, City, State, Country, plus
 * Door Count / Reacted To when the export asked for them.
 */
type Ctx = { params: Promise<{ id: string }> }

export async function GET(req: Request, ctx: Ctx) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await ctx.params).id)
  if (!id) return NextResponse.json({ error: 'invalid_id' }, { status: 400 })
  try {
    const exp = await getExport(id)
    if (!exp) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    const [rows, names] = await Promise.all([exportRows(exp.reactor_ids), influencerNames()])
    const { csv } = influencerApolloCsv(rows, { names, doorCount: !!exp.filters.door_count_column, reactedTo: !!exp.filters.reacted_to_column })
    const day = exp.created_at.slice(0, 10)
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="pm-influencer-leads-${day}-${rows.length}.csv"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    return dbErrorResponse(err, 'api/influencers/exports/[id]')
  }
}
