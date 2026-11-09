import { TABS } from '@/components/shell/tabs'

/**
 * The tabs split into the pipeline's numbered flow (owner, 2026-11-09:
 * numbers instead of "Stage N", so the order reads as steps) and the
 * utilities around it. Tabs not named here fall into the tools.
 */
const FLOW_ORDER = ['/import', '/import/leads', '/progress', '/rotate', '/campaigns'] as const
const TOOL_ORDER = ['/overview', '/agent', '/crm', '/calendar', '/playground', '/operator', '/settings']

export type NavTab = (typeof TABS)[number] & { step?: number; key?: string }

/** Alt + key jumps to a tool from anywhere on desktop (flow steps use Alt + their number). */
const TOOL_KEYS: Record<string, string> = { '/overview': 'O', '/agent': 'A', '/crm': 'C', '/calendar': 'K', '/playground': 'P', '/operator': 'R', '/settings': 'S' }

export const FLOW: NavTab[] = FLOW_ORDER.flatMap((href, i) => {
  const t = TABS.find((x) => x.href === href)
  return t ? [{ ...t, step: i + 1, key: String(i + 1) }] : []
})

export const TOOLS: NavTab[] = TABS.filter((t) => !FLOW.some((f) => f.href === t.href))
  .map((t) => ({ ...t, key: TOOL_KEYS[t.href] }))
  .sort((a, b) => rank(a.href) - rank(b.href))

function rank(href: string) {
  const i = TOOL_ORDER.indexOf(href)
  return i < 0 ? TOOL_ORDER.length : i
}

/** "3 Progress" for a flow tab, the bare label otherwise. */
export const navLabel = (t: NavTab) => (t.step ? `${t.step} ${t.label}` : t.label)

/** The tab an Alt-chord (KeyboardEvent.code, layout-independent) points at. */
export function tabForChord(code: string): NavTab | undefined {
  const m = /^(?:Digit|Numpad)(\d)$/.exec(code) ?? /^Key([A-Z])$/.exec(code)
  if (!m) return undefined
  return [...FLOW, ...TOOLS].find((t) => t.key === m[1])
}
