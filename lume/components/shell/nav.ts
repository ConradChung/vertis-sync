import { TABS } from '@/components/shell/tabs'

/**
 * The tabs split into the pipeline's numbered flow (owner, 2026-11-09:
 * numbers instead of "Stage N", so the order reads as steps) and the
 * utilities around it. Tabs not named here fall into the tools.
 *
 * GTM-18: the numbers are the lead's five steps (lib/leads/steps.ts):
 * 1 Imported (Import), 2 Combined and 3 Filtered (both on Lead lists),
 * 4 Validated (Progress), 5 In campaign (Campaigns). Rotate is a tool, not
 * a step. Alt + the step's first digit jumps to it (Alt+3 also opens Lead lists).
 */
const FLOW_STEPS: { href: string; step: string }[] = [
  { href: '/import', step: '1' },
  { href: '/import/leads', step: '2–3' },
  { href: '/progress', step: '4' },
  { href: '/campaigns', step: '5' },
]
const TOOL_ORDER = ['/overview', '/actions', '/agent', '/crm', '/rotate', '/signals/hiring', '/calendar', '/playground', '/operator', '/settings']

/** `step` is the step text shown beside a flow tab ("1", "2–3"). */
export type NavTab = (typeof TABS)[number] & { step?: string; key?: string }

/** Alt + key jumps to a tool from anywhere on desktop (flow steps use Alt + their number). */
const TOOL_KEYS: Record<string, string> = { '/overview': 'O', '/actions': 'Y', '/agent': 'A', '/crm': 'C', '/rotate': 'T', '/calendar': 'K', '/playground': 'P', '/operator': 'R', '/settings': 'S' }

export const FLOW: NavTab[] = FLOW_STEPS.flatMap(({ href, step }) => {
  const t = TABS.find((x) => x.href === href)
  return t ? [{ ...t, step, key: step.charAt(0) }] : []
})

export const TOOLS: NavTab[] = TABS.filter((t) => !FLOW.some((f) => f.href === t.href))
  .map((t) => ({ ...t, key: TOOL_KEYS[t.href] }))
  .sort((a, b) => rank(a.href) - rank(b.href))

function rank(href: string) {
  const i = TOOL_ORDER.indexOf(href)
  return i < 0 ? TOOL_ORDER.length : i
}

/** "4 Progress" for a flow tab, the bare label otherwise. */
export const navLabel = (t: NavTab) => (t.step ? `${t.step} ${t.label}` : t.label)

/** The tab an Alt-chord (KeyboardEvent.code, layout-independent) points at. */
export function tabForChord(code: string): NavTab | undefined {
  const m = /^(?:Digit|Numpad)(\d)$/.exec(code) ?? /^Key([A-Z])$/.exec(code)
  if (!m) return undefined
  // Steps 2 and 3 share Lead lists, so Alt+3 lands there as well.
  const key = m[1] === '3' ? '2' : m[1]
  return [...FLOW, ...TOOLS].find((t) => t.key === key)
}
