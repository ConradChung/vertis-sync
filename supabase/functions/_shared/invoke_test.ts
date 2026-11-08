// Run: deno test --allow-read _shared/invoke_test.ts
import { assert, assertEquals } from 'jsr:@std/assert@1'
import { keepAlive } from './invoke.ts'

Deno.test('keepAlive registers the promise with EdgeRuntime.waitUntil and returns it', async () => {
  const seen: Promise<unknown>[] = []
  const g = globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }
  g.EdgeRuntime = { waitUntil: (p) => void seen.push(p) }
  try {
    const p = Promise.resolve(7)
    assertEquals(await keepAlive(p), 7)
    assertEquals(seen, [p])
  } finally {
    delete g.EdgeRuntime
  }
})

Deno.test('keepAlive without EdgeRuntime (tests, local) just returns the promise', async () => {
  assertEquals(await keepAlive(Promise.resolve('ok')), 'ok')
})

// The systemic bug: a function that ends with a fire-and-forget
// fetch(`…/functions/v1/…`).catch(…) can be shut down before the request is
// sent, and the chain dies silently (job 16f26ffc sat on "processing" for two
// days). Every function-to-function call must be awaited or kept alive.
Deno.test('every function-to-function fetch is awaited or kept alive', async () => {
  const offenders: string[] = []
  for await (const dir of Deno.readDir(new URL('..', import.meta.url))) {
    if (!dir.isDirectory || dir.name.startsWith('_')) continue
    let src: string
    try {
      src = await Deno.readTextFile(new URL(`../${dir.name}/index.ts`, import.meta.url))
    } catch {
      continue
    }
    src.split('\n').forEach((line, i) => {
      const at = line.indexOf('fetch(`${SUPABASE_URL}/functions/v1/')
      if (at < 0) return
      const before = line.slice(0, at)
      if (!/\bawait\s*$/.test(before) && !/keepAlive\(\s*$/.test(before)) offenders.push(`${dir.name}/index.ts:${i + 1}`)
    })
  }
  assert(offenders.length === 0, `un-awaited function hand-offs:\n${offenders.join('\n')}`)
})
