import 'server-only'
import { z } from 'zod'
import { fileInConversation } from '@/lib/agent/chatFiles'
import { loadSourceRows } from '@/lib/apollo/source'
import { exportRows, getExport } from '@/lib/influencers/store'
import { keptRows } from '@/lib/leads/lists/reviewRows'
import { EDITABLE_FIELDS, INLINE_MAX_ROWS, inlineItem, leadFromMapped, parsePastedRows, type ItemSource } from '@/lib/leads/lists/model'
import type { IncomingRow } from '@/lib/leads/lists/store'
import { loadAttachmentLeads } from '@/lib/review/attachmentSource'
import { LEAD_FIELDS } from '@/lib/review/columns'
import { normaliseLead } from '@/lib/review/model'

/** Where an append's rows come from (the agent's append_to_lead_list, the auto-append, the Leads page). */
const InlineRow = z.partialRecord(z.enum(EDITABLE_FIELDS), z.string().max(500))
export const AppendSource = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('attachment'),
    file_id: z.string().uuid(),
    sheet: z.string().min(1).max(200).optional(),
    columns: z.partialRecord(z.enum(LEAD_FIELDS), z.string().max(200)).optional(),
  }),
  z.object({ kind: z.literal('review_set'), set_id: z.string().uuid() }),
  z.object({ kind: z.literal('actor_run'), run_id: z.string().regex(/^[A-Za-z0-9]{8,40}$/).optional(), dataset_id: z.string().regex(/^[A-Za-z0-9]{8,40}$/).optional() }).refine((v) => !!v.run_id !== !!v.dataset_id, 'run_id or dataset_id'),
  z.object({ kind: z.literal('influencer_export'), export_id: z.string().uuid() }),
  z.object({ kind: z.literal('inline'), rows: z.array(InlineRow).min(1).max(5000) }),
  z.object({ kind: z.literal('paste'), text: z.string().max(2_000_000) }),
])
export type AppendSource = z.infer<typeof AppendSource>

export class SourceRefused extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code)
    this.name = 'SourceRefused'
  }
}

/** `by`: the agent's bearer or the owner's page (inline / pasted rows are tagged agent or manual). */
export async function rowsFromSource(src: AppendSource, ctx: { conversationId?: string | null; by: 'agent' | 'owner' }): Promise<{ rows: IncomingRow[]; label: string; mapping?: unknown; unmapped?: string[] }> {
  const typed = (source: ItemSource) => (r: { raw: Record<string, unknown> | null; item: IncomingRow['item'] }): IncomingRow => ({ ...r, source })
  switch (src.kind) {
    case 'attachment': {
      const fileId = src.file_id.toLowerCase()
      if (ctx.conversationId && !(await fileInConversation(fileId, ctx.conversationId))) throw new SourceRefused(404, 'file_not_found')
      const sheet = await loadAttachmentLeads(fileId, src.sheet, src.columns ?? {})
      return {
        label: sheet.label,
        mapping: sheet.mapping,
        unmapped: sheet.unmapped,
        rows: sheet.rows.map((raw) => typed('attachment')({ raw, item: leadFromMapped(raw, sheet.mapping) })),
      }
    }
    case 'review_set':
      return { label: 'review set', rows: (await keptRows(src.set_id.toLowerCase())).map(typed('review_set')) }
    case 'actor_run': {
      const { rows, label } = await loadSourceRows(src.run_id ? { kind: 'run', id: src.run_id } : { kind: 'dataset', id: src.dataset_id! })
      return { label, rows: rows.map((raw) => typed('actor_run')({ raw, item: normaliseLead(raw) })) }
    }
    case 'influencer_export': {
      const exp = await getExport(src.export_id.toLowerCase())
      if (!exp) throw new SourceRefused(404, 'export_not_found')
      const reactors = await exportRows(exp.reactor_ids)
      return {
        label: 'influencer export',
        rows: reactors.map((r) => {
          const raw = {
            fullname: r.name,
            jobtitle: r.title,
            companyname: r.company_name,
            website: r.company_website,
            linkedinurl: r.linkedin_url,
            city: r.city,
            state: r.state,
            country: r.country,
            door_count: r.door_count,
            reacted_to: (r.reacted_to ?? []).join('; '),
          }
          return typed('influencer_export')({ raw, item: normaliseLead(raw) })
        }),
      }
    }
    case 'inline': {
      if (ctx.by === 'agent' && src.rows.length > INLINE_MAX_ROWS) throw new SourceRefused(400, `too_many_inline_rows: at most ${INLINE_MAX_ROWS} per call`)
      return { label: 'inline rows', rows: src.rows.map((r) => typed(ctx.by === 'agent' ? 'agent' : 'manual')({ raw: { ...r }, item: inlineItem(r) })) }
    }
    case 'paste': {
      const p = parsePastedRows(src.text)
      if (!p.ok) throw new SourceRefused(422, p.error)
      return { label: 'pasted rows', mapping: p.mapping, unmapped: p.unmapped, rows: p.rows.map(typed(ctx.by === 'agent' ? 'agent' : 'manual')) }
    }
  }
}
