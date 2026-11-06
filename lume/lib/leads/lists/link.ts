/** The chat's "Open in Leads" button (pure): a tool result that names a lead list deep-links to it. */

export interface ToolLink {
  label: string
  href: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function leadListLink(result: Record<string, unknown> | null | undefined): ToolLink | null {
  const l = result?.lead_list as { list_id?: unknown } | null | undefined
  if (!l || typeof l.list_id !== 'string' || !UUID.test(l.list_id)) return null
  return { label: 'Open in Leads', href: `/import/leads?list=${l.list_id.toLowerCase()}` }
}

/** The distinct links of a message's tool calls, in order. */
export function uniqueLinks(tools: readonly { link?: ToolLink }[]): ToolLink[] {
  const seen = new Set<string>()
  const out: ToolLink[] = []
  for (const t of tools) if (t.link && !seen.has(t.link.href)) (seen.add(t.link.href), out.push(t.link))
  return out
}
