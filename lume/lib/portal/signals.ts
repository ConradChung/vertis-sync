import type { Scoreboard } from '@/lib/scoreboard/count'
import type { SignalRow, SignalSource, SignalStatus } from '@/lib/signals/merge'

/**
 * The client portal's signal section (pure): which client sees it and what
 * each account shows. Signals come from Kaspen's lanes (posts, hiring,
 * Reddit, influencer reactions), so only that client's portal gets them;
 * `LUME_SIGNALS_CLIENT` renames it without a deploy of code.
 */

export const DEFAULT_SIGNALS_CLIENT = 'Kaspen'

export function signalsClient(env: Record<string, string | undefined> = process.env): string {
  return env.LUME_SIGNALS_CLIENT?.trim() || DEFAULT_SIGNALS_CLIENT
}

/** Only the signals client's portal users see signal accounts and the scoreboard (compared without case). */
export function portalSeesSignals(client: string | null | undefined, env: Record<string, string | undefined> = process.env): boolean {
  return !!client && client.trim().toLowerCase() === signalsClient(env).toLowerCase()
}

/** A signal account as the client sees it: who to call and why. No owner notes, no deal. */
export interface PortalSignalAccount {
  key: string
  company: string
  website: string | null
  phone: string | null
  sources: SignalSource[]
  /** The newest signal's short text. Scraped: plain text only. */
  untrusted_signal: string
  signal_at: string | null
  contact: { name: string; title: string | null; linkedin: string | null } | null
  status: SignalStatus
  /** When a call was ticked, if it was. */
  called_at: string | null
}

export interface PortalSignalsResponse {
  /** False for a client that has no signal lanes: the section is not rendered. */
  enabled: boolean
  accounts: PortalSignalAccount[]
  /** Accounts beyond the ones listed. */
  more: number
  scoreboard: Scoreboard | null
}

export const PORTAL_SIGNALS_SHOWN = 25

/**
 * Today's accounts to call: companies (not Reddit authors) still open (new
 * or working) with no call ticked yet. The ones with a phone number come
 * first, then the newest signal.
 */
export function portalSignalAccounts(rows: readonly SignalRow[], limit = PORTAL_SIGNALS_SHOWN): { accounts: PortalSignalAccount[]; more: number } {
  const open = rows.filter((r) => !r.key.startsWith('r:') && (r.status === 'new' || r.status === 'working') && !r.touches.call)
  // `rows` arrive newest first; a stable sort keeps that order inside each half.
  const sorted = [...open].sort((a, b) => Number(!!b.phone) - Number(!!a.phone))
  return {
    more: Math.max(0, sorted.length - limit),
    accounts: sorted.slice(0, limit).map((r) => ({
      key: r.key,
      company: r.name,
      website: r.domain,
      phone: r.phone,
      sources: r.sources,
      untrusted_signal: r.newest.label,
      signal_at: r.newest.at,
      contact: r.contacts[0] ?? null,
      status: r.status,
      called_at: r.touches.call,
    })),
  }
}
