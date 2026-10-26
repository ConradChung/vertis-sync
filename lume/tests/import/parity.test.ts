import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Drift guard: Lume's email-column detection is a copy of telegram-inbox's
 * (edge functions share no code with the Next.js apps). If either side
 * changes, this fails until both match again — the owner prompt Lume sends
 * must name the column telegram-inbox will use at approval.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const UPSTREAM = read('../../../supabase/functions/telegram-inbox/index.ts')
const LUME = read('../../lib/import/csv.ts')

function fn(src: string, name: string): string {
  const start = src.search(new RegExp(`^(?:export )?function ${name}\\(`, 'm'))
  expect(start, `function ${name}`).toBeGreaterThanOrEqual(0)
  const end = src.indexOf('\n}\n', start)
  return src.slice(start, end + 2)
}

function constLine(src: string, name: string): string {
  const m = new RegExp(`^(?:export )?const ${name}\\b.*$`, 'm').exec(src)
  expect(m, `const ${name}`).not.toBeNull()
  return m![0]
}

/** Whitespace-, comment-, semicolon-, `export`- and arrow-paren-insensitive. */
const norm = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/.*$/gm, '$1')
    .replace(/^export /gm, '')
    .replace(/\((\w+)\)\s*=>/g, '$1 =>')
    .replace(/;/g, '')
    .replace(/\s+/g, '')

describe('telegram-inbox parity', () => {
  it.each(['normalizeHeader', 'detectEmailColumn', 'parseCSVRow', 'headerFromBytes', 'countDataRows'])('function %s matches', (name) => {
    expect(norm(fn(LUME, name))).toBe(norm(fn(UPSTREAM, name)))
  })
  it.each(['DROPPED_COLUMNS', 'TIER1_NAMES', 'PERSONAL_SUBSTRINGS'])('const %s matches', (name) => {
    expect(norm(constLine(LUME, name))).toBe(norm(constLine(UPSTREAM, name)))
  })
})
