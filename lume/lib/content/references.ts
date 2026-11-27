import 'server-only'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { References } from '@/lib/content/prompt'

/**
 * The MIT-licensed LinkedIn reference files (lib/content/references/, see
 * LICENSE there), read from disk at runtime. next.config.ts ships them with
 * every server function through outputFileTracingIncludes.
 */

let cached: References | null = null

export function loadReferences(): References {
  if (cached) return cached
  const read = (f: string) => readFileSync(path.join(process.cwd(), 'lib', 'content', 'references', f), 'utf8')
  cached = { hookFormulas: read('hook-formulas.md'), humanizer: read('humanizer-checklist.md'), algorithm: read('algorithm-heuristics.md') }
  return cached
}
