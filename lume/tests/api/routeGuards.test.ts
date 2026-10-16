import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Every route handler under app/api must authenticate itself: either the
 * owner (`requireOwner`) or a shared secret (`requireSecret`), both from
 * `@/lib/auth/guards`. The middleware is a second line, not the first — a
 * route that forgets its guard would still be reachable with a valid bearer
 * or from a future public-path change.
 *
 * Routes that are their own gate go in the allowlist, with the reason.
 */
const ALLOWLIST: Record<string, string> = {
  'app/api/auth/magic-link/route.ts': 'owner-gated by shouldSendMagicLink(); it is the login step itself',
}

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

function routeFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...routeFiles(p))
    else if (name === 'route.ts' || name === 'route.tsx') out.push(p)
  }
  return out.sort()
}

const GUARD_IMPORT = /import\s*\{([^}]*)\}\s*from\s*['"]@\/lib\/auth\/guards['"]/

describe('app/api route guards', () => {
  const files = routeFiles(join(ROOT, 'app/api')).map((f) => relative(ROOT, f))

  it('finds the API routes', () => {
    expect(files.length).toBeGreaterThanOrEqual(7)
    expect(files).toContain('app/api/gates/route.ts')
    expect(files).toContain('app/api/hooks/gate-opened/route.ts')
  })

  it('every allowlisted path still exists (no stale entries)', () => {
    for (const p of Object.keys(ALLOWLIST)) expect(files, p).toContain(p)
  })

  for (const file of files) {
    if (ALLOWLIST[file]) continue
    it(`${file} imports requireOwner or requireSecret from @/lib/auth/guards`, () => {
      const src = readFileSync(join(ROOT, file), 'utf8')
      const m = GUARD_IMPORT.exec(src)
      expect(m, 'no import from @/lib/auth/guards').not.toBeNull()
      const names = m![1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0])
      const guard = names.find((n) => n === 'requireOwner' || n === 'requireSecret')
      expect(guard, 'imports neither requireOwner nor requireSecret').toBeDefined()
      // Imported and actually called, not just imported.
      expect(new RegExp(`${guard}\\s*\\(`).test(src), `${guard} is imported but never called`).toBe(true)
    })
  }
})
