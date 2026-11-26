import { TABS, type Tab } from '@/components/shell/tabs'

/**
 * The menu in three groups (owner, 2026-11-26): the five primary tabs (the
 * path to a paying customer), the collapsed Volume group and Admin.
 *
 * GTM-18: Volume keeps the lead's five numbered steps (lib/leads/steps.ts):
 * 1 Imported (Import), 2 Combined and 3 Filtered (both on Lead lists),
 * 4 Validated (Progress), 5 In campaign (Campaigns). Rotate sits in the group
 * between Progress and Campaigns as a tool, not a step. Alt + the step's
 * first digit jumps to it (Alt+3 also opens Lead lists).
 */
const STEPS: Record<string, string> = { '/import': '1', '/import/leads': '2–3', '/progress': '4', '/campaigns': '5' }

/** Alt + key jumps to a tab from anywhere on desktop (flow steps use Alt + their number). Keyed by label so a tab keeps its key when its page moves. */
const KEYS: Record<string, string> = { Today: 'D', Signals: 'G', Pipeline: 'L', Replies: 'Y', Agent: 'A', Rotate: 'T', Playground: 'P', Operator: 'R', Settings: 'S', Calendar: 'K', Overview: 'O' }

/** A letter from before the regroup still lands on the same work: ⌥C (CRM) is Pipeline. */
const KEY_ALIASES: Record<string, string> = { C: 'L' }

/** `step` is the step text shown beside a flow tab ("1", "2–3"). */
export type NavTab = Tab & { step?: string; key?: string }

const withKeys = (t: Tab): NavTab => {
  const step = STEPS[t.href]
  return step ? { ...t, step, key: step.charAt(0) } : { ...t, key: KEYS[t.label] }
}
const group = (g: Tab['group']): NavTab[] => TABS.filter((t) => t.group === g).map(withKeys)

/** Today, Signals, Pipeline, Replies, Agent. */
export const PRIMARY: NavTab[] = group('primary')
/** Import, Leads, Progress, Rotate, Campaigns: the numbered volume flow with Rotate in place. */
export const VOLUME: NavTab[] = group('volume')
/** Playground, Operator, Settings. */
export const ADMIN: NavTab[] = group('admin')
/** Pages with a URL and a ⌘K entry but no menu slot. */
export const MORE: NavTab[] = group('more')

/** Every tab in menu order. */
export const NAV: NavTab[] = [...PRIMARY, ...VOLUME, ...ADMIN, ...MORE]

/** The numbered steps alone (1 Import … 5 Campaigns). */
export const FLOW: NavTab[] = VOLUME.filter((t) => t.step)

/** "4 Progress" for a flow tab, the bare label otherwise. */
export const navLabel = (t: NavTab) => (t.step ? `${t.step} ${t.label}` : t.label)

/** The tab an Alt-chord (KeyboardEvent.code, layout-independent) points at. */
export function tabForChord(code: string): NavTab | undefined {
  const m = /^(?:Digit|Numpad)(\d)$/.exec(code) ?? /^Key([A-Z])$/.exec(code)
  if (!m) return undefined
  // Steps 2 and 3 share Lead lists, so Alt+3 lands there as well.
  const key = m[1] === '3' ? '2' : (KEY_ALIASES[m[1]] ?? m[1])
  return NAV.find((t) => t.key === key)
}
