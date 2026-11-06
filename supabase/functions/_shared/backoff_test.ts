// Run: deno test _shared/backoff_test.ts
import { assertEquals, assertRejects } from 'jsr:@std/assert@1'
import { fetchWithBackoff } from './backoff.ts'

const res = (status: number) => new Response(status === 200 ? '{}' : 'slow down', { status })

Deno.test('fetchWithBackoff: retries 429 / 5xx with the given waits, then returns the success', async () => {
  const statuses = [429, 503, 200]
  const waited: number[] = []
  const r = await fetchWithBackoff(() => Promise.resolve(res(statuses.shift()!)), { waits: [5, 10, 20], sleep: (ms) => { waited.push(ms); return Promise.resolve() } })
  assertEquals(r.status, 200)
  assertEquals(waited, [5, 10])
})

Deno.test('fetchWithBackoff: a non-retryable status or exhausted waits returns the last response (caller decides)', async () => {
  assertEquals((await fetchWithBackoff(() => Promise.resolve(res(400)), { waits: [5], sleep: () => Promise.resolve() })).status, 400)
  assertEquals((await fetchWithBackoff(() => Promise.resolve(res(429)), { waits: [5], sleep: () => Promise.resolve() })).status, 429)
})

Deno.test('fetchWithBackoff: no retry when the wait would run past the deadline', async () => {
  let calls = 0
  const r = await fetchWithBackoff(() => { calls++; return Promise.resolve(res(429)) }, { waits: [5_000], now: () => 0, deadline: 4_000, sleep: () => Promise.resolve() })
  assertEquals([r.status, calls], [429, 1])
})

Deno.test('fetchWithBackoff: a thrown network error propagates', async () => {
  await assertRejects(() => fetchWithBackoff(() => Promise.reject(new Error('reset')), { waits: [5], sleep: () => Promise.resolve() }), Error, 'reset')
})
