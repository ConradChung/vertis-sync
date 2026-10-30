// Stage 5: Haiku headline triage against the decision-maker titles
// (config.yaml decision_maker_titles). Pure. Ported from pm/triage.py.
import { buildJsonRequest, type JsonRequest } from './haiku.ts'

export const DECISION_MAKER_TITLES = [
  'owner', 'founder', 'co-founder', 'ceo', 'president', 'principal', 'broker-owner', 'broker/owner',
  'managing partner', 'managing broker', 'managing director',
] as const

export const TRIAGE_SYSTEM = `You triage LinkedIn headlines. Label each as:
- "likely": the headline indicates a decision-maker (${DECISION_MAKER_TITLES.join(', ')}) at a property management company,
  or at a real estate brokerage that clearly does property management.
- "possible": the headline suggests a senior person in property management or residential real
  estate, but it is unclear whether they are a decision-maker or whether the company does PM.
- "no": anything else, including vendors selling to PMs, software companies, coaches,
  consultants, employees (leasing, maintenance, coordinators), investors who are not PM operators.
Be strict. "Property manager" with no ownership signal is "possible", not "likely".`

export const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, label: { type: 'string', enum: ['likely', 'possible', 'no'] } },
        required: ['id', 'label'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
}

export const TRIAGE_BATCH = 50
export type TriageLabel = 'likely' | 'possible' | 'no'

export function triageTodo<T extends { id: number; headline: string | null }>(rows: T[]): { noCall: number[]; ask: T[] } {
  const noCall: number[] = []
  const ask: T[] = []
  for (const r of rows) {
    if ((r.headline ?? '').trim()) ask.push(r)
    else noCall.push(r.id)
  }
  return { noCall, ask }
}

export function triageRequest(batch: { id: number; headline: string | null }[]): JsonRequest {
  const lines = batch.map((r) => `${r.id}\t${(r.headline ?? '').replace(/[\t\r\n]+/g, ' ').slice(0, 300)}`)
  return buildJsonRequest(TRIAGE_SYSTEM, 'One headline per line as `id<TAB>headline`. Return a label for every id.\n\n' + lines.join('\n'), TRIAGE_SCHEMA, 4096)
}

export function parseTriage(json: unknown, ids: number[]): Record<number, TriageLabel> {
  const results = (json && typeof json === 'object' ? (json as { results?: unknown }).results : null)
  if (!Array.isArray(results)) throw new Error('triage: results missing')
  const got = new Map<string, TriageLabel>()
  for (const r of results) {
    const o = (r ?? {}) as { id?: unknown; label?: unknown }
    if (typeof o.id === 'string' && (o.label === 'likely' || o.label === 'possible' || o.label === 'no')) got.set(o.id.trim(), o.label)
  }
  const out: Record<number, TriageLabel> = {}
  for (const id of ids) out[id] = got.get(String(id)) ?? 'no'
  return out
}
