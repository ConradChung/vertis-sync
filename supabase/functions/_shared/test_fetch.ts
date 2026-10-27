// Test-only: a global fetch stub that routes by URL and records every call.
// Imported by *_test.ts files only, so it is never bundled into a function.

export interface Recorded { url: string; method: string; body: string | null }
export type Route = [match: (url: string, method: string) => boolean, respond: (url: string, body: string | null) => Response]

export function stubFetch(routes: Route[]): { calls: Recorded[]; restore: () => void } {
  const calls: Recorded[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? init.body : init?.body ? '<bytes>' : null
    calls.push({ url, method, body })
    for (const [match, respond] of routes) if (match(url, method)) return respond(url, body)
    throw new Error(`test_fetch: no route for ${method} ${url}`)
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = real } }
}

/** The functions read their env and call Deno.serve at import; set the env and neutralise serve first. */
export function prepareModule(env: Record<string, string>): void {
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v)
  Deno.env.delete('ALERT_CHANNELS')
  // deno-lint-ignore no-explicit-any
  ;(Deno as any).serve = () => ({ finished: Promise.resolve(), shutdown: () => Promise.resolve() })
}

export const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
