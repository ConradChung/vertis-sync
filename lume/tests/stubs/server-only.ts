// Vitest stand-in for the `server-only` package, which throws on import
// outside a React Server Components bundle. Aliased in vitest.config.mts so
// server-only modules can be unit-tested; the real guard still applies in
// `next build`.
export {}
