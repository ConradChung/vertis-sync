import { GATE_KINDS, type GateKind, type GateRow } from '@/lib/db/types'

/** `?gate=<kind>:<target_id>` (the Telegram deep link). Pure. */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const KINDS: ReadonlySet<string> = new Set(GATE_KINDS)

export interface GateRef {
  kind: GateKind
  targetId: string
  key: string
}

export function parseGateParam(value: string | null | undefined): GateRef | null {
  if (!value) return null
  const parts = value.trim().split(':')
  if (parts.length !== 2) return null
  const [kind, id] = parts
  if (!KINDS.has(kind) || !UUID_RE.test(id)) return null
  const targetId = id.toLowerCase()
  return { kind: kind as GateKind, targetId, key: `${kind}:${targetId}` }
}

export function gateKey(g: Pick<GateRow, 'kind' | 'target_id'>): string {
  return `${g.kind}:${g.target_id}`
}
