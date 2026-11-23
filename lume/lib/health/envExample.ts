/**
 * Parsers for the two `.env.example` files, the source of truth for which
 * secret names exist (names only; these files never hold values). Pure.
 *
 * - `lume/.env.example` (Vercel): every `NAME=` line. A name is optional when
 *   the comment that describes it says "optional" or "unset = …". A comment
 *   block describes the name right under it and the uncommented names that
 *   follow it before the next blank line or the next comment. Commented-out
 *   names (`# LUME_SMOKE=1`, shell only) are not listed.
 * - root `.env.example`: the commented block under "Supabase edge-function
 *   secrets" (`# NAME=   what it is for`), up to "Lume's own Vercel env". A
 *   name is optional when its note starts with "optional".
 */

export interface EnvName {
  name: string
  required: boolean
}

const VAR = /^([A-Z][A-Z0-9_]*)=/
const COMMENTED_VAR = /^#\s*([A-Z][A-Z0-9_]*)=\s*(.*)$/
const OPTIONAL = /\boptional\b|\bunset\s*=/i

export function parseLumeEnvExample(text: string): EnvName[] {
  const out: EnvName[] = []
  const seen = new Set<string>()
  let pending: string[] = []
  let group: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) {
      pending = []
      group = []
      continue
    }
    if (line.startsWith('#')) {
      if (COMMENTED_VAR.test(line)) continue
      pending.push(line.replace(/^#\s?/, ''))
      continue
    }
    const m = VAR.exec(line)
    if (!m) continue
    if (pending.length) {
      group = pending
      pending = []
    }
    if (seen.has(m[1])) continue
    seen.add(m[1])
    out.push({ name: m[1], required: !OPTIONAL.test(group.join(' ')) })
  }
  return out
}

const EDGE_START = /edge-function secrets/i
const EDGE_END = /Lume's own Vercel env/i

export function parseEdgeSecretNames(text: string): EnvName[] {
  const out: EnvName[] = []
  const seen = new Set<string>()
  let inside = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!inside) {
      if (line.startsWith('#') && EDGE_START.test(line)) inside = true
      continue
    }
    if (EDGE_END.test(line)) break
    const m = COMMENTED_VAR.exec(line)
    if (!m || seen.has(m[1])) continue
    seen.add(m[1])
    out.push({ name: m[1], required: !/^optional\b/i.test(m[2].trim()) })
  }
  return out
}
