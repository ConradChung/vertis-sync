// Bounded retry on 429 / 5xx for one vendor call (Perplexity 429s above ~2
// concurrent; see _shared/influencer/verify.ts). Waits run in order; no wait
// is started that would end past `deadline` (the invocation's chunk limit).
// Returns the last response either way: the caller turns a non-ok one into
// its own error, exactly as before.
export async function fetchWithBackoff(
  call: () => Promise<Response>,
  opts: { waits: readonly number[]; deadline?: number; now?: () => number; sleep?: (ms: number) => Promise<void> },
): Promise<Response> {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  for (let attempt = 0; ; attempt++) {
    const res = await call()
    const retryable = res.status === 429 || (res.status >= 500 && res.status < 600)
    const wait = opts.waits[attempt]
    if (res.ok || !retryable || wait === undefined || (opts.deadline !== undefined && now() + wait > opts.deadline)) return res
    await res.body?.cancel()
    await sleep(wait)
  }
}
