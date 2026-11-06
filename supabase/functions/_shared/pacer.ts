// Spaces calls to the returned function at least `intervalMs` apart, however
// many callers await it concurrently. Shared by email-validator (MailTester,
// 1 s) and operating-city-enricher (Perplexity, 1 s).
export function makePacer(intervalMs: number, now = () => Date.now(), sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))) {
  let next = 0
  return async (): Promise<void> => {
    const t = now()
    const wait = Math.max(0, next - t)
    next = Math.max(t, next) + intervalMs
    if (wait > 0) await sleep(wait)
  }
}
