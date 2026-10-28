/**
 * A campaign's leads that are NO LONGER in Instantly, from `lead_bank`: the
 * rotator (instantly-rotate) deletes finished, bounced and (after 7 days)
 * replied leads and archives their rows (state completed / bounced /
 * unsubscribed / skipped, `final_status` = Instantly status at removal,
 * `email_reply_count`); remove_leads archives the same way. Instantly's
 * `/leads/list` cannot see them, so its replied / bounced counts only cover
 * leads still uploaded. Pure.
 */

export interface ArchivedRow {
  state: string
  final_status: number | null
  email_reply_count: number | null
}

export interface ArchivedSummary {
  total: number
  replied: number
  bounced: number
  finished_no_reply: number
}

export function summarizeArchived(rows: ArchivedRow[]): ArchivedSummary {
  const out: ArchivedSummary = { total: 0, replied: 0, bounced: 0, finished_no_reply: 0 }
  for (const r of rows) {
    out.total++
    const replied = (r.email_reply_count ?? 0) > 0
    if (replied) out.replied++
    if (r.state === 'bounced' || r.final_status === -1) out.bounced++
    else if (!replied && (r.state === 'completed' || r.final_status === 3)) out.finished_no_reply++
  }
  return out
}

/** One line for the agent when Instantly's counts would read as "none" but history has some. */
export function historyNote(h: ArchivedSummary): string | null {
  const parts: string[] = []
  if (h.replied) parts.push(`${h.replied} replied lead${h.replied === 1 ? '' : 's'}`)
  if (h.bounced) parts.push(`${h.bounced} bounced`)
  if (h.finished_no_reply) parts.push(`${h.finished_no_reply} finished with no reply`)
  if (!parts.length) return null
  return (
    `Counts above are leads in Instantly now. ${parts.join(', ')} from this campaign are no longer in Instantly ` +
    '(already removed by the rotator or remove_leads; kept in Lume history), so they cannot be listed or removed here.'
  )
}
