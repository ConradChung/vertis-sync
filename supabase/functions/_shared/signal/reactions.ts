// STUB (agent A): agent C owns this file and replaces it with the real
// reactor ingest. Contract: ingest finished reactions-lane runs into
// signal_people (kind 'reactor', stage 'crawl'). `rest(path)` calls
// `${SUPABASE_URL}/rest/v1/${path}` with service-role headers.
export async function ingestReactorRuns(
  _rest: (path: string, init?: RequestInit) => Promise<Response>,
  _now: Date,
): Promise<{ ingested: number }> {
  return await Promise.resolve({ ingested: 0 })
}
