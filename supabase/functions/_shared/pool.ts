// A small worker pool for the edge functions' row loops (operating-city-enricher;
// the same rules email-validator's inline workers follow):
//  - at most `concurrency` items in flight, each start spaced by the shared
//    `pace` (one rate limit across all workers, not per worker);
//  - once `shouldStop()` is true (near the chunk limit) no new item is taken;
//    the in-flight ones finish;
//  - a throw stops the siblings before they take another item, the pool waits
//    for every in-flight item to settle, then rethrows the first error — so the
//    caller can settle its counters knowing nothing is still running.
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  work: (item: T) => Promise<void>,
  opts: { pace?: () => Promise<void>; shouldStop?: () => boolean } = {},
): Promise<{ stopped: boolean; processed: number }> {
  const queue = [...items]
  let stop = false
  let stopped = false
  let processed = 0
  let firstError: unknown = undefined
  const worker = async (): Promise<void> => {
    while (!stop) {
      if (opts.shouldStop?.()) {
        stop = true
        stopped = true
        return
      }
      const item = queue.shift()
      if (item === undefined) return
      if (opts.pace) await opts.pace()
      if (stop) {
        queue.unshift(item)
        return
      }
      try {
        await work(item)
        processed++
      } catch (err) {
        stop = true
        if (firstError === undefined) firstError = err
        return
      }
    }
  }
  await Promise.allSettled(Array.from({ length: Math.max(1, concurrency) }, worker))
  if (firstError !== undefined) throw firstError
  return { stopped, processed }
}
