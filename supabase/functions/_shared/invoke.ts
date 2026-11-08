// Keep a background request alive past the response. A function that ends with
// a fire-and-forget fetch(...).catch(...) can have its isolate shut down before
// the request is even sent, and the next function in the chain never runs.
// Where awaiting would slow a request path (telegram-inbox answering
// Telegram's webhook), hand the promise to EdgeRuntime.waitUntil instead: the
// response is not delayed and the runtime keeps the isolate until it settles.
// Elsewhere (worker loops already inside waitUntil), simply await the fetch.
type Runtime = { waitUntil(p: Promise<unknown>): void }

export function keepAlive<T>(p: Promise<T>): Promise<T> {
  const rt = (globalThis as { EdgeRuntime?: Runtime }).EdgeRuntime
  rt?.waitUntil(p)
  return p
}
