// Run: deno test _shared/pool_test.ts
import { assertEquals, assertRejects } from 'jsr:@std/assert@1'
import { runPool } from './pool.ts'

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

Deno.test('runPool: at most `concurrency` in flight, every item once, each start goes through the shared pacer first', async () => {
  let inFlight = 0
  let peak = 0
  let paced = 0
  const pacedBeforeStart: boolean[] = []
  const done: number[] = []
  const r = await runPool([1, 2, 3, 4, 5], 2, async (n) => {
    pacedBeforeStart.push(paced >= done.length + inFlight + 1)
    inFlight++
    peak = Math.max(peak, inFlight)
    await tick()
    inFlight--
    done.push(n)
  }, { pace: () => { paced++; return Promise.resolve() } })
  assertEquals(r, { stopped: false, processed: 5 })
  assertEquals(peak, 2)
  assertEquals(paced, 5)
  assertEquals(pacedBeforeStart.every(Boolean), true)
  assertEquals(done.sort(), [1, 2, 3, 4, 5])
})

Deno.test('runPool: once shouldStop says so, no new item is taken; in-flight ones finish', async () => {
  let n = 0
  const seen: number[] = []
  const r = await runPool([1, 2, 3, 4, 5, 6], 2, async (x) => { await tick(); seen.push(x); n++ }, { shouldStop: () => n >= 2 })
  assertEquals(r.stopped, true)
  assertEquals(seen.length >= 2 && seen.length <= 3, true)
})

Deno.test('runPool: a throw stops the siblings, waits for the in-flight work, then rethrows', async () => {
  const finished: number[] = []
  await assertRejects(
    () => runPool([1, 2, 3, 4, 5, 6], 2, async (x) => {
      if (x === 1) { await tick(); throw new Error('boom') }
      await tick(); await tick()
      finished.push(x)
    }),
    Error,
    'boom',
  )
  // Item 2 was in flight when 1 threw and still finished; nothing after it started.
  assertEquals(finished, [2])
})
