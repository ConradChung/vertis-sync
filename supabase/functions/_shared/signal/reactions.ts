// GTM-14 reactions lane: ingest of the weekly influencer runs Lume filed for
// Frank's posts (lume/lib/signal/reactions.ts files them; the owner taps).
//
// signal-comments calls ingestReactorRuns every tick:
//   filed/running posts → the influencer run whose start_action_id is the
//   post's reactions_action_id (the one-tap card sets both start_action_id and
//   reactions_action_id to the card's id).
//     running / awaiting      → reactions_status 'running', reactions_run_id
//     failed / cancelled      → 'skipped' + note, reservation released
//     card rejected / expired → 'skipped' + note, reservation released
//     done                    → verified, never-exported reactors of the post
//                               become signal_people (kind 'reactor') unless the
//                               person is already there (commenter wins, never
//                               downgraded); reservations settle to the run's
//                               actual reactions cost, pro-rated by each post's
//                               reactions; 'done'.
//   then markDigestsReady: a done post whose reactors have all settled gets
//   digest_status 'ready' (some reactor reached ready) or 'empty'.
//
// knownSignalReactorIds is the influencer-reactions triage pre-spend dedupe for
// those runs: reactors already in signal_people are excluded before Haiku.

export type Rest = (path: string, init?: RequestInit) => Promise<Response>

const LANE = 'reactions_apify'
/** Stages where a reactor no longer moves (signal_people.stage). */
const SETTLED = new Set(['ready', 'skipped', 'alerted', 'error'])
const REACHED_READY = new Set(['ready', 'alerted'])
const BATCH = 100

const r4 = (n: number) => Math.round(n * 10_000) / 10_000
const enc = encodeURIComponent

/** https://www.linkedin.com/in/<slug>: no query, hash or trailing slash; www and https forced. */
export function normLinkedinUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  let u = raw.trim().replace(/[?#].*$/, '').replace(/\/+$/, '')
  u = u.replace(/^http:\/\//i, 'https://').replace(/^https:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\//i, 'https://www.linkedin.com/')
  return /^https:\/\/www\.linkedin\.com\/.+/.test(u) ? u : null
}

/** PostgREST in.(...) list of quoted values. */
const quotedList = (vals: string[]) => `(${vals.map((v) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')})`

async function getJson<T>(rest: Rest, path: string): Promise<T> {
  const res = await rest(path)
  if (!res.ok) throw new Error(`GET ${path.split('?')[0]} failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
  return (await res.json()) as T
}

async function send(rest: Rest, method: string, path: string, body: unknown, prefer = 'return=minimal'): Promise<Response> {
  const res = await rest(path, { method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'Prefer': prefer } })
  if (!res.ok) throw new Error(`${method} ${path.split('?')[0]} failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
  await res.body?.cancel()
  return res
}

/** Existing signal_people keys among these people (by normalized URL or LinkedIn id). */
async function existingPeople(rest: Rest, people: { url: string | null; id: string | null }[]): Promise<{ urls: Set<string>; ids: Set<string> }> {
  const urls = new Set<string>()
  const ids = new Set<string>()
  const allUrls = [...new Set(people.map((p) => p.url).filter((x): x is string => !!x))]
  const allIds = [...new Set(people.map((p) => p.id).filter((x): x is string => !!x))]
  for (let i = 0; i < Math.max(allUrls.length, allIds.length); i += BATCH) {
    const u = allUrls.slice(i, i + BATCH)
    const d = allIds.slice(i, i + BATCH)
    const ors = [...(u.length ? [`linkedin_url.in.${quotedList(u)}`] : []), ...(d.length ? [`linkedin_id.in.${quotedList(d)}`] : [])]
    if (!ors.length) continue
    const rows = await getJson<{ linkedin_url: string | null; linkedin_id: string | null }[]>(
      rest, `signal_people?or=${enc(`(${ors.join(',')})`)}&select=linkedin_url,linkedin_id`)
    for (const r of rows) {
      const n = normLinkedinUrl(r.linkedin_url)
      if (n) urls.add(n)
      if (r.linkedin_id) ids.add(r.linkedin_id)
    }
  }
  return { urls, ids }
}

// ---------------------------------------------------------------------------
// Triage pre-spend dedupe (influencer-reactions)

const signalRunCache = new Map<string, boolean>()

/**
 * Is this influencer run one Lume filed for the reactions lane? Its
 * start_action_id is a filed post's reactions_action_id. Unreadable (e.g. the
 * signal tables not migrated yet) → false: the run triages as before.
 */
export async function isSignalRun(rest: Rest, runId: string): Promise<boolean> {
  const hit = signalRunCache.get(runId)
  if (hit !== undefined) return hit
  try {
    const [run] = await getJson<{ start_action_id: string | null }[]>(rest, `influencer_runs?id=eq.${enc(runId)}&select=start_action_id`)
    if (!run?.start_action_id) {
      signalRunCache.set(runId, false)
      return false
    }
    const posts = await getJson<unknown[]>(rest, `signal_posts?reactions_action_id=eq.${enc(run.start_action_id)}&select=post_id&limit=1`)
    signalRunCache.set(runId, posts.length > 0)
    return posts.length > 0
  } catch {
    return false
  }
}

/**
 * Reactor ids (influencer_reactors.id) of a signal run's triage batch that are
 * already in signal_people, any kind (one PostgREST query per batch). Not a
 * signal run → []. A signal run whose signal_people read fails throws, so the
 * step retries instead of spending on people who may be known.
 */
export async function knownSignalReactorIds(
  rest: Rest,
  runId: string,
  rows: { id: number; linkedin_url?: string | null; linkedin_id?: string | null }[],
): Promise<number[]> {
  if (!rows.length || !(await isSignalRun(rest, runId))) return []
  const known = await existingPeople(rest, rows.map((r) => ({ url: normLinkedinUrl(r.linkedin_url), id: r.linkedin_id ?? null })))
  return rows
    .filter((r) => {
      const u = normLinkedinUrl(r.linkedin_url)
      return (u !== null && known.urls.has(u)) || (!!r.linkedin_id && known.ids.has(r.linkedin_id))
    })
    .map((r) => r.id)
}

// ---------------------------------------------------------------------------
// Ingest

interface PostRow {
  post_id: string
  reactions_status: 'filed' | 'running'
  reactions_action_id: string | null
  reactions_run_id: string | null
}

interface Reactor {
  linkedin_url: string
  linkedin_id: string | null
  name: string | null
  headline: string | null
  title: string | null
  company_name: string | null
  company_website: string | null
  location: string | null
  door_count: number | null
  door_count_source: string | null
  door_count_confidence: string | null
}

const REACTOR_COLS = 'linkedin_url,linkedin_id,name,headline,title,company_name,company_website,location,door_count,door_count_source,door_count_confidence'

const firstName = (name: string | null) => (name ?? '').trim().split(/\s+/)[0] || null

/** signal_people insert for a new reactor. */
export function reactorRow(r: Reactor, postId: string, runId: string): Record<string, unknown> | null {
  const url = normLinkedinUrl(r.linkedin_url)
  if (!url) return null
  const website = typeof r.company_website === 'string' && r.company_website.trim() ? r.company_website.trim() : null
  return {
    linkedin_url: url,
    linkedin_id: r.linkedin_id || null,
    kind: 'reactor',
    post_id: postId,
    reactor_run_id: runId,
    name: r.name,
    first_name: firstName(r.name),
    headline: r.headline,
    title: r.title,
    company_name: r.company_name,
    company_website: website,
    company_guess: null,
    location: r.location,
    door_count: r.door_count,
    door_count_source: r.door_count_source,
    door_count_confidence: r.door_count_confidence,
    stage: website ? 'crawl' : 'skipped',
    skip_reason: website ? null : 'no_website',
  }
}

/** Split `total` across keys by weight (equal when all weights are 0); 4 decimals, summing to total. */
export function prorate(total: number, weights: Record<string, number>): Record<string, number> {
  const keys = Object.keys(weights)
  if (!keys.length) return {}
  const sum = keys.reduce((s, k) => s + Math.max(0, weights[k]), 0)
  const out: Record<string, number> = {}
  let given = 0
  keys.forEach((k, i) => {
    if (i === keys.length - 1) out[k] = r4(Math.max(0, total - given))
    else {
      out[k] = r4(sum > 0 ? (total * Math.max(0, weights[k])) / sum : total / keys.length)
      given += out[k]
    }
  })
  return out
}

async function patchPosts(rest: Rest, ids: string[], from: string[], patch: Record<string, unknown>, now: Date): Promise<void> {
  if (!ids.length) return
  await send(rest, 'PATCH', `signal_posts?post_id=in.${enc(quotedList(ids))}&reactions_status=in.(${from.join(',')})`, { ...patch, updated_at: now.toISOString() })
}

async function releaseReservations(rest: Rest, ids: string[], now: Date): Promise<void> {
  if (!ids.length) return
  await send(rest, 'PATCH', `signal_spend?lane=eq.${LANE}&status=eq.reserved&post_id=in.${enc(quotedList(ids))}`, { status: 'released', settled_at: now.toISOString() })
}

/** How many reactors the run recorded for the post (exact count, no rows). */
async function postReactionCount(rest: Rest, postId: string): Promise<number> {
  const res = await rest(`influencer_reactors?reacted_posts=cs.${enc(`{${postId}}`)}&select=id&limit=1`, { headers: { 'Prefer': 'count=exact' } })
  if (!res.ok) throw new Error(`count reactors failed (${res.status})`)
  await res.body?.cancel()
  const total = Number((res.headers.get('content-range') ?? '').split('/')[1])
  return Number.isFinite(total) ? total : 0
}

async function ingestPost(rest: Rest, postId: string, runId: string): Promise<number> {
  const reactors = await getJson<Reactor[]>(rest,
    `influencer_reactors?reacted_posts=cs.${enc(`{${postId}}`)}&verdict=eq.verified&exported_at=is.null&select=${REACTOR_COLS}&order=id`)
  if (!reactors.length) return 0
  const known = await existingPeople(rest, reactors.map((r) => ({ url: normLinkedinUrl(r.linkedin_url), id: r.linkedin_id })))
  const seen = new Set<string>()
  const rows: Record<string, unknown>[] = []
  for (const r of reactors) {
    const row = reactorRow(r, postId, runId)
    if (!row) continue
    const url = row.linkedin_url as string
    if (known.urls.has(url) || (r.linkedin_id && known.ids.has(r.linkedin_id)) || seen.has(url)) continue
    seen.add(url)
    rows.push(row)
  }
  if (!rows.length) return 0
  // ignore-duplicates on linkedin_url: a row written since the check (e.g. a new commenter) is never overwritten.
  const res = await rest('signal_people?on_conflict=linkedin_url', {
    method: 'POST', body: JSON.stringify(rows),
    headers: { 'Content-Type': 'application/json', 'Prefer': 'resolution=ignore-duplicates,return=representation' },
  })
  if (res.ok) return ((await res.json()) as unknown[]).length
  await res.body?.cancel()
  if (res.status !== 409) throw new Error(`POST signal_people failed (${res.status})`)
  // A linkedin_id clash inside the batch: one by one, skipping the clashing rows.
  let n = 0
  for (const row of rows) {
    const one = await rest('signal_people?on_conflict=linkedin_url', {
      method: 'POST', body: JSON.stringify(row),
      headers: { 'Content-Type': 'application/json', 'Prefer': 'resolution=ignore-duplicates,return=representation' },
    })
    if (one.ok) n += ((await one.json()) as unknown[]).length
    else if (one.status === 409) await one.body?.cancel()
    else throw new Error(`POST signal_people failed (${one.status})`)
  }
  return n
}

export async function ingestReactorRuns(rest: Rest, now: Date): Promise<{ ingested: number }> {
  let ingested = 0
  const posts = await getJson<PostRow[]>(rest,
    'signal_posts?reactions_status=in.(filed,running)&reactions_action_id=not.is.null&select=post_id,reactions_status,reactions_action_id,reactions_run_id')
  const byAction = new Map<string, PostRow[]>()
  for (const p of posts) byAction.set(p.reactions_action_id!, [...(byAction.get(p.reactions_action_id!) ?? []), p])

  for (const [actionId, group] of byAction) {
    const ids = group.map((p) => p.post_id)
    const [run] = await getJson<{ id: string; status: string; error: string | null }[]>(rest,
      `influencer_runs?start_action_id=eq.${enc(actionId)}&select=id,status,error&limit=1`)
    if (!run) {
      // No run yet: the card may still be waiting for the tap. A card that will never run frees its posts.
      const [action] = await getJson<{ status: string }[]>(rest, `pending_actions?id=eq.${enc(actionId)}&select=status`)
      if (action && ['rejected', 'expired', 'failed'].includes(action.status)) {
        await patchPosts(rest, ids, ['filed'], { reactions_status: 'skipped', reactions_note: `skipped: reactions card ${action.status}` }, now)
        await releaseReservations(rest, ids, now)
      }
      continue
    }
    if (run.status === 'running' || run.status === 'awaiting_approval') {
      if (group.some((p) => p.reactions_status !== 'running' || p.reactions_run_id !== run.id)) {
        await patchPosts(rest, ids, ['filed', 'running'], { reactions_status: 'running', reactions_run_id: run.id }, now)
      }
      continue
    }
    if (run.status !== 'done') {
      await patchPosts(rest, ids, ['filed', 'running'], {
        reactions_status: 'skipped', reactions_run_id: run.id,
        reactions_note: `skipped: influencer run ${run.status}${run.error ? ` (${run.error.slice(0, 200)})` : ''}`,
      }, now)
      await releaseReservations(rest, ids, now)
      continue
    }

    for (const id of ids) ingested += await ingestPost(rest, id, run.id)

    // Settle: the run's actual reactions cost, pro-rated by each post's reactions.
    const apifyRows = await getJson<{ cost_usd: number | string }[]>(rest,
      `influencer_apify_runs?run_id=eq.${enc(run.id)}&kind=eq.reactions&select=cost_usd`)
    const actual = r4(apifyRows.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0))
    const weights: Record<string, number> = {}
    for (const id of ids) weights[id] = ids.length === 1 ? 1 : await postReactionCount(rest, id)
    const shares = prorate(actual, weights)
    for (const id of ids) {
      await send(rest, 'PATCH', `signal_spend?lane=eq.${LANE}&status=eq.reserved&post_id=eq.${enc(id)}`,
        { status: 'settled', usd: shares[id], settled_at: now.toISOString() })
    }
    await patchPosts(rest, ids, ['filed', 'running'], { reactions_status: 'done', reactions_run_id: run.id, reactions_note: `done: run ${run.id}, Apify $${actual.toFixed(2)}` }, now)
  }

  await markDigestsReady(rest)
  return { ingested }
}

/** Done posts whose reactors have all settled: 'ready' when one reached ready, else 'empty'. */
export async function markDigestsReady(rest: Rest): Promise<void> {
  const posts = await getJson<{ post_id: string }[]>(rest, 'signal_posts?reactions_status=eq.done&digest_status=is.null&select=post_id')
  if (!posts.length) return
  for (let i = 0; i < posts.length; i += BATCH) {
    const ids = posts.slice(i, i + BATCH).map((p) => p.post_id)
    const people = await getJson<{ post_id: string; stage: string }[]>(rest,
      `signal_people?kind=eq.reactor&post_id=in.${enc(quotedList(ids))}&select=post_id,stage`)
    for (const id of ids) {
      const mine = people.filter((p) => p.post_id === id)
      if (mine.some((p) => !SETTLED.has(p.stage))) continue
      const status = mine.some((p) => REACHED_READY.has(p.stage)) ? 'ready' : 'empty'
      await send(rest, 'PATCH', `signal_posts?post_id=eq.${enc(id)}&digest_status=is.null`, { digest_status: status, updated_at: new Date().toISOString() })
    }
  }
}
