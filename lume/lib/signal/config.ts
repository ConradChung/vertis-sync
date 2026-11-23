/**
 * GTM-14 signal lane: config and facts Lume needs (pure).
 *
 *  - `lume_settings.signal_config` (migration lume_signal_comments) is
 *    parsed here. Anything that is not exactly `dry_run: false` counts as a
 *    dry run, so a malformed row never posts to Slack.
 *  - FRANK_FACTS mirrors the three flags Lume reads from
 *    supabase/functions/_shared/signal/frank-facts.json. Turbopack's root is
 *    pinned to lume/, so the JSON cannot be imported at build time;
 *    tests/signal/facts.test.ts fails when the two drift.
 */

export const SIGNAL_CONFIG_KEY = 'signal_config'

export const FRANK_FACTS = {
  linkedin_premium: false,
  connection_note_max_chars: 200,
  connections_csv_loaded: false,
} as const

export interface SignalSlackConfig {
  team_id: string | null
  channel_id: string | null
  channel_name: string
}

export interface SignalConfig {
  dry_run: boolean
  slack: SignalSlackConfig
  reactor_opening: string | null
  /** The whole stored value, so a write-back keeps keys Lume does not know. */
  raw: Record<string, unknown>
}

const TEAM = /^[TE][A-Z0-9]{2,30}$/
const CHANNEL = /^[CG][A-Z0-9]{2,30}$/

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})

export function parseSignalConfig(value: unknown): SignalConfig {
  const raw = obj(value)
  const slack = obj(raw.slack)
  const opening = typeof raw.reactor_opening === 'string' && raw.reactor_opening.trim() ? raw.reactor_opening.trim() : null
  const name = typeof slack.channel_name === 'string' && slack.channel_name.trim() ? slack.channel_name.trim().replace(/^#/, '') : 'sales'
  return {
    dry_run: raw.dry_run !== false,
    slack: {
      team_id: typeof slack.team_id === 'string' && TEAM.test(slack.team_id) ? slack.team_id : null,
      channel_id: typeof slack.channel_id === 'string' && CHANNEL.test(slack.channel_id) ? slack.channel_id : null,
      channel_name: name,
    },
    reactor_opening: opening,
    raw,
  }
}

/** Card options from the facts file. Connected is only trusted once Connections.csv was loaded. */
export function signalCardOpts(now: Date = new Date()) {
  return {
    premium: FRANK_FACTS.linkedin_premium as boolean,
    noteLimit: FRANK_FACTS.connection_note_max_chars as number,
    connectionsLoaded: FRANK_FACTS.connections_csv_loaded as boolean,
    now,
  }
}
