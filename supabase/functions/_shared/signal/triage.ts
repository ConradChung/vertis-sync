// GTM-14: Haiku headline triage that also pulls the company name out of the
// headline (company_guess), in the same call. Labels and rules follow
// _shared/influencer/triage.ts (unchanged); the signal verification question
// adds "likely works at {company_guess}". Pure.
import { buildJsonRequest, type JsonRequest } from '../influencer/haiku.ts'
import { TRIAGE_SYSTEM, type TriageLabel } from '../influencer/triage.ts'
import { verificationQuestion } from '../influencer/verify.ts'
import { clip } from '../text.ts'

export const SIGNAL_TRIAGE_SYSTEM = `${TRIAGE_SYSTEM}

Also return "company": the name of the company the headline says they work at or own, exactly as
written in the headline (e.g. "Owner at Whitfield Property Management" → "Whitfield Property Management").
Use null when the headline names no company.`

export const SIGNAL_TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          label: { type: 'string', enum: ['likely', 'possible', 'no'] },
          company: { type: ['string', 'null'] },
        },
        required: ['id', 'label', 'company'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
}

export const SIGNAL_TRIAGE_BATCH = 25

export function signalTriageRequest(batch: { id: number; headline: string | null }[]): JsonRequest {
  const lines = batch.map((r) => `${r.id}\t${clip((r.headline ?? '').replace(/[\t\r\n]+/g, ' '), 300)}`)
  return buildJsonRequest(SIGNAL_TRIAGE_SYSTEM,
    'One headline per line as `id<TAB>headline`. Return a label and company for every id.\n\n' + lines.join('\n'),
    SIGNAL_TRIAGE_SCHEMA, 4096)
}

export interface SignalTriage { label: TriageLabel; company: string | null }

/** Every id gets a result; a missing one is "no" with no company. */
export function parseSignalTriage(json: unknown, ids: number[]): Record<number, SignalTriage> {
  const results = json && typeof json === 'object' ? (json as { results?: unknown }).results : null
  if (!Array.isArray(results)) throw new Error('triage: results missing')
  const got = new Map<string, SignalTriage>()
  for (const r of results) {
    const o = (r ?? {}) as { id?: unknown; label?: unknown; company?: unknown }
    if (typeof o.id !== 'string' || !(o.label === 'likely' || o.label === 'possible' || o.label === 'no')) continue
    const c = typeof o.company === 'string' ? o.company.replace(/\s+/g, ' ').trim().slice(0, 200) : ''
    got.set(o.id.trim(), { label: o.label, company: c && !/^(null|none|n\/a)$/i.test(c) ? c : null })
  }
  const out: Record<number, SignalTriage> = {}
  for (const id of ids) out[id] = got.get(String(id)) ?? { label: 'no', company: null }
  return out
}

const q = (s: string) => s.replace(/"/g, "'").replace(/\s+/g, ' ').trim().slice(0, 200)

/** The influencer verification question, with "likely works at {company_guess}" when known. */
export function signalVerificationQuestion(name: string, headline: string, companyGuess: string | null): string {
  const base = verificationQuestion(name, headline)
  if (!companyGuess?.trim()) return base
  const [first, ...rest] = base.split('\n')
  return [`${first} This person likely works at "${q(companyGuess)}".`, ...rest].join('\n')
}
