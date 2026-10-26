/**
 * Apify actor input schemas, pure: a compact field list the agent shows the
 * owner before any run, and the server-side check `run_actor` applies to the
 * inputs the owner gave. Apify fills in `default` values for missing fields;
 * `prefill` is only a console hint and is NOT applied to API runs, so a
 * prefilled value the owner wants must be sent explicitly.
 */

type Raw = Record<string, unknown>
const obj = (v: unknown): Raw | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null)

export interface InputSchema {
  title?: string
  properties: Record<string, Raw>
  required: string[]
}

/** `actorDefinition.input` (object) or the build's `inputSchema` (JSON string). */
export function parseInputSchema(raw: unknown): InputSchema | null {
  let v = raw
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return null
    }
  }
  const s = obj(v)
  const props = obj(s?.properties)
  if (!s || !props) return null
  const properties: Record<string, Raw> = {}
  for (const [k, p] of Object.entries(props)) {
    const o = obj(p)
    if (o) properties[k] = o
  }
  const required = Array.isArray(s.required) ? s.required.filter((x): x is string => typeof x === 'string' && x in properties) : []
  return { title: typeof s.title === 'string' ? s.title : undefined, properties, required }
}

export interface InputField {
  name: string
  title: string
  type: string
  required: boolean
  /** Required, or the actor suggests a value: show these to the owner. */
  important: boolean
  description: string
  default?: unknown
  /** Console suggestion only; send it explicitly if wanted. */
  prefill?: unknown
  enum?: unknown[]
  minimum?: number
  maximum?: number
  editor?: string
  /** This field costs extra (the actor marks it with "$"). */
  costsExtra: boolean
}

const stripHtml = (s: string) =>
  s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const short = (v: unknown) => {
  const s = JSON.stringify(v)
  return s !== undefined && s.length > 300 ? `${s.slice(0, 300)}…` : v
}

export function summarizeSchema(schema: InputSchema, maxFields = 40): InputField[] {
  const req = new Set(schema.required)
  const fields = Object.entries(schema.properties).map(([name, p]): InputField => {
    const title = typeof p.title === 'string' ? stripHtml(p.title) : name
    const description = typeof p.description === 'string' ? clip(stripHtml(p.description), 240) : ''
    const f: InputField = {
      name,
      title,
      type: typeof p.type === 'string' ? p.type : 'any',
      required: req.has(name),
      important: req.has(name) || p.prefill !== undefined,
      description,
      costsExtra: /\(\$\)|\$\)/.test(`${p.title ?? ''} ${p.description ?? ''}`),
    }
    if (p.default !== undefined) f.default = short(p.default)
    if (p.prefill !== undefined) f.prefill = short(p.prefill)
    if (Array.isArray(p.enum)) f.enum = p.enum.slice(0, 30)
    if (typeof p.minimum === 'number') f.minimum = p.minimum
    if (typeof p.maximum === 'number') f.maximum = p.maximum
    if (typeof p.editor === 'string') f.editor = p.editor
    return f
  })
  // Required first, then suggested, then the rest, keeping schema order within each.
  const rank = (f: InputField) => (f.required ? 0 : f.important ? 1 : 2)
  return fields
    .map((f, i) => ({ f, i }))
    .sort((a, b) => rank(a.f) - rank(b.f) || a.i - b.i)
    .slice(0, maxFields)
    .map((x) => x.f)
}

function typeOk(type: unknown, v: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof v === 'string'
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v)
    case 'number':
      return typeof v === 'number' && Number.isFinite(v)
    case 'boolean':
      return typeof v === 'boolean'
    case 'array':
      return Array.isArray(v)
    case 'object':
      return !!obj(v)
    default:
      return true
  }
}

const empty = (v: unknown) =>
  v === undefined || v === null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && v.length === 0)

/**
 * Problems with `input` against `schema`, as plain sentences; empty means
 * valid. Unknown fields are refused (an input the actor doesn't define is an
 * invented one). With `noResidentialProxy`, a proxy config asking for
 * RESIDENTIAL is refused (billed per GB, can't be capped).
 */
export function validateActorInput(
  schema: InputSchema,
  input: unknown,
  opts: { noResidentialProxy?: boolean } = {}
): string[] {
  const errors: string[] = []
  const o = obj(input)
  if (!o) return ['input must be a JSON object']
  for (const k of schema.required) {
    if (empty(o[k]) && schema.properties[k]?.default === undefined) errors.push(`${k} is required`)
  }
  for (const [k, v] of Object.entries(o)) {
    const p = schema.properties[k]
    if (!p) {
      errors.push(`${k} is not an input of this actor`)
      continue
    }
    if (v === null) continue
    if (!typeOk(p.type, v)) {
      errors.push(`${k} must be ${p.type === 'integer' ? 'a whole number' : `${/^[aeiou]/.test(String(p.type)) ? 'an' : 'a'} ${p.type}`}`)
      continue
    }
    if (Array.isArray(p.enum) && !p.enum.includes(v)) errors.push(`${k} must be one of ${p.enum.slice(0, 12).map(String).join(', ')}`)
    if (typeof v === 'number') {
      if (typeof p.minimum === 'number' && v < p.minimum) errors.push(`${k} must be at least ${p.minimum}`)
      if (typeof p.maximum === 'number' && v > p.maximum) errors.push(`${k} must be at most ${p.maximum}`)
    }
    if (typeof v === 'string' && !Array.isArray(p.enum) && typeof p.pattern === 'string') {
      try {
        if (!new RegExp(p.pattern).test(v)) errors.push(`${k} does not match the expected format`)
      } catch {
        // unparseable pattern: Apify validates it anyway
      }
    }
    if (opts.noResidentialProxy && (p.editor === 'proxy' || k.toLowerCase().includes('proxy'))) {
      const groups = obj(v)?.apifyProxyGroups
      if (Array.isArray(groups) && groups.some((g) => String(g).toUpperCase().includes('RESIDENTIAL'))) {
        errors.push(`${k}: residential proxy is billed per GB and can't be capped; use the default (datacenter) proxy`)
      }
    }
  }
  return errors
}

/** "searchStringsArray: roofers, solar · locationQuery: Austin, TX" — for summaries. */
export function describeInput(input: Record<string, unknown>, max = 320): string {
  const parts = Object.entries(input).map(([k, v]) => {
    const s = Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ') : typeof v === 'string' ? v : JSON.stringify(v)
    return `${k}: ${clip(s ?? 'null', 80)}`
  })
  return clip(parts.join(' · '), max)
}
