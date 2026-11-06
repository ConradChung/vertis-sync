import { assert, assertEquals } from 'jsr:@std/assert@1'
import { makePacer } from './pacer.ts'

Deno.test('makePacer spaces starts across concurrent callers', async () => {
  const pace = makePacer(50)
  const starts: number[] = []
  // Three workers, five calls each, with no request latency at all — the
  // worst case for the rate limit.
  await Promise.all([0, 1, 2].map(async () => {
    for (let i = 0; i < 5; i++) { await pace(); starts.push(performance.now()) }
  }))
  starts.sort((a, b) => a - b)
  for (let i = 1; i < starts.length; i++) assert(starts[i] - starts[i - 1] >= 35, `gap ${i}: ${starts[i] - starts[i - 1]}`)
  assertEquals(starts.length, 15)
})

Deno.test('makePacer: at most 10 starts in any 10s window (MailTester allows 11)', async () => {
  const t0 = Date.now()
  const pace = makePacer(100)  // scaled 10x: 100ms here = 1000ms live
  const starts: number[] = []
  await Promise.all([0, 1, 2].map(async () => {
    for (let i = 0; i < 8; i++) {
      await pace(); starts.push(Date.now() - t0)
      await new Promise((r) => setTimeout(r, Math.random() * 300)) // 0-3s scaled latency
    }
  }))
  starts.sort((a, b) => a - b)
  for (const s of starts) {
    const inWindow = starts.filter((x) => x >= s && x < s + 1000).length
    assert(inWindow <= 11, `window at ${s}: ${inWindow}`)
  }
  assertEquals(starts.length, 24)
})
