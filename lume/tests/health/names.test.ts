import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseEdgeSecretNames, parseLumeEnvExample } from '@/lib/health/envExample'
import { EDGE_ENV_NAMES, LUME_ENV_NAMES } from '@/lib/health/names'

const LUME_ROOT = join(__dirname, '..', '..')
const read = (p: string) => readFileSync(join(LUME_ROOT, p), 'utf8')

describe('parseLumeEnvExample', () => {
  it('lists NAME= lines, marks optional ones by their comment, skips commented-out names', () => {
    const text = [
      '# Supabase',
      'A_URL=',
      'A_KEY=',
      '',
      '# Optional: an override',
      'B=',
      '# Calendar sync. Unset = stays local.',
      'C=',
      '# shell only',
      '# SMOKE=1',
      'D=',
      '',
      'E=',
      'A_URL=',
    ].join('\n')
    expect(parseLumeEnvExample(text)).toEqual([
      { name: 'A_URL', required: true },
      { name: 'A_KEY', required: true },
      { name: 'B', required: false },
      { name: 'C', required: false },
      { name: 'D', required: true },
      { name: 'E', required: true },
    ])
  })

  it('LUME_ENV_NAMES matches lume/.env.example (edit both together)', () => {
    expect(parseLumeEnvExample(read('.env.example'))).toEqual(LUME_ENV_NAMES)
  })
})

describe('parseEdgeSecretNames', () => {
  it('reads only the commented edge block; "optional" notes are optional', () => {
    const text = [
      'NEXT_ONLY=',
      '# Supabase edge-function secrets — NOT read from this file.',
      '# TOKEN_A=            what for',
      '# OPT_B=              optional; has a default',
      '#',
      '# SHEET_ID=abc123',
      "# Lume's own Vercel env (…):",
      '#   NOT_THIS, NOR_THIS',
      '# AFTER=',
    ].join('\n')
    expect(parseEdgeSecretNames(text)).toEqual([
      { name: 'TOKEN_A', required: true },
      { name: 'OPT_B', required: false },
      { name: 'SHEET_ID', required: true },
    ])
  })

  it('EDGE_ENV_NAMES matches the root .env.example', () => {
    expect(parseEdgeSecretNames(read('../.env.example'))).toEqual(EDGE_ENV_NAMES)
  })

  it('the config-health edge function checks exactly the same names', () => {
    const src = read('../supabase/functions/config-health/names.ts')
    const names = [...src.matchAll(/^\s*'([A-Z][A-Z0-9_]*)',$/gm)].map((m) => m[1])
    expect(names).toEqual(EDGE_ENV_NAMES.map((n) => n.name))
  })
})
