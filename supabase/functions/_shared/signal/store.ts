// GTM-14: the comments lane's database access, behind an interface so the tick
// is tested against an in-memory fake (the contract migration isn't applied).
// restStore implements it over PostgREST with the service role.

export type Rest = (path: string, init?: RequestInit) => Promise<Response>

export interface SignalState {
  last_posts_7d_at: string | null
  last_posts_48h_at: string | null
  first_run_at: string | null
  stopped_at: string | null
  stopped_reason: string | null
}

export interface PostRow {
  post_id: string
  post_url: string
  posted_at: string
  likes: number | null
  comment_count: number
  comments_pulled_at_count: number
  last_comments_pull_at: string | null
  digest_status: string | null
}

export type Stage = 'new' | 'triage' | 'verify' | 'crawl' | 'doors' | 'contacts' | 'draft' | 'ready' | 'alerted' | 'skipped' | 'error' | 'held'

export interface Person {
  id: number
  linkedin_id: string | null
  linkedin_url: string
  name: string | null
  first_name: string | null
  headline: string | null
  company_guess: string | null
  kind: 'commenter' | 'reactor'
  post_id: string | null
  comment_text: string | null
  comment_url: string | null
  commented_at: string | null
  stage: Stage
  skip_reason: string | null
  attempts: number
  last_error: string | null
  triage: string | null
  company_name: string | null
  company_website: string | null
  title: string | null
  location: string | null
  is_decision_maker: boolean | null
  segment: 'pm' | 'owner_operator'
  crawl_verdict: string | null
  crawl_reason: string | null
  doors_hint: string | null
  door_count: number | null
  door_count_source: string | null
  door_count_confidence: string | null
  contacts: unknown
  connected: boolean | null
  drafts: unknown
  alert_status: string | null
  spend_usd: number
}

export interface SpendRow {
  id: number
  lane: string
  kind: string
  status: 'reserved' | 'settled' | 'released'
  usd: number
  apify_run_id: string | null
  dataset_id: string | null
  post_id: string | null
  person_id: number | null
  created_at: string
}

export interface NewSpend {
  lane: 'comments_apify' | 'comments_filter'
  kind: string
  status: 'reserved' | 'settled'
  usd: number
  post_id?: string | null
  person_id?: number | null
}

export interface NewPost {
  post_id: string
  post_url: string
  posted_at: string
  likes: number | null
  comment_count: number
  text_excerpt: string | null
}

export interface KnownReactor { linkedin_id: string | null; linkedin_url: string; verdict: string | null; exported_at: string | null }

export interface Store {
  claimTick(token: string, seconds: number): Promise<boolean>
  releaseTick(token: string): Promise<void>
  settings(): Promise<{ signalConfig: unknown; apifyCapUsd: number | null }>
  state(): Promise<SignalState>
  patchState(patch: Partial<SignalState>): Promise<void>

  laneSpend(lanes: string[], since: string): Promise<number>
  openApifyReservedUsd(): Promise<number>
  insertSpend(row: NewSpend): Promise<number>
  patchSpend(id: number, patch: Partial<SpendRow> & { settled_at?: string }, onlyIfReserved?: boolean): Promise<boolean>
  reservedApifyRuns(): Promise<SpendRow[]>
  insertNotice(key: string, text: string): Promise<boolean>

  upsertPosts(rows: NewPost[]): Promise<void>
  recentPosts(since: string): Promise<PostRow[]>
  patchPost(postId: string, patch: Partial<PostRow>): Promise<void>
  postsDigest(postIds: string[]): Promise<Record<string, string | null>>

  peopleByKeys(ids: string[], urls: string[]): Promise<Person[]>
  reactorsByKeys(ids: string[], urls: string[]): Promise<KnownReactor[]>
  lumeLinkedinUrls(urls: string[]): Promise<string[]>
  lumeLinkedinKeys(keys: string[]): Promise<string[]>
  insertPerson(row: Partial<Person>): Promise<'inserted' | 'conflict'>
  /** PATCH; when `stage` is given only a row still at that stage changes. Returns whether a row changed. */
  patchPerson(id: number, patch: Partial<Person>, stage?: Stage): Promise<boolean>
  peopleAt(stage: Stage, kind: 'commenter' | 'reactor', limit: number): Promise<Person[]>
}

// ---------------------------------------------------------------------------
// PostgREST implementation

/** A PostgREST in-list with every value double-quoted (commas, parens and dots in URLs are safe). */
export function inList(values: string[]): string {
  return `(${values.map((v) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')})`
}
const enc = (s: string) => encodeURIComponent(s)

export function restStore(rest: Rest): Store {
  async function call(method: string, path: string, body?: unknown, prefer = 'return=minimal'): Promise<unknown> {
    const res = await rest(path, {
      method,
      headers: { 'Content-Type': 'application/json', 'Prefer': prefer },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300)
      const err = new Error(`Supabase ${method} ${path.split('?')[0]} ${res.status}: ${text}`) as Error & { status: number }
      err.status = res.status
      throw err
    }
    const ct = res.headers.get('content-type') ?? ''
    if (ct.includes('json')) return res.json()
    await res.body?.cancel()
    return null
  }
  const get = (path: string) => call('GET', path) as Promise<unknown[]>
  const rpc = (fn: string, args: Record<string, unknown>) => call('POST', `rpc/${fn}`, args, 'return=representation')
  const now = () => new Date().toISOString()

  return {
    async claimTick(token, seconds) {
      return (await rpc('signal_claim_tick', { p_token: token, p_seconds: seconds })) === true
    },
    async releaseTick(token) {
      await call('PATCH', `signal_state?id=eq.1&lease_token=eq.${enc(token)}`, { lease_until: null, updated_at: now() })
    },
    async settings() {
      const rows = (await get('lume_settings?key=in.(signal_config,apify_monthly_cap_usd)&select=key,value')) as { key: string; value: unknown }[]
      const cap = Number(rows.find((r) => r.key === 'apify_monthly_cap_usd')?.value)
      return { signalConfig: rows.find((r) => r.key === 'signal_config')?.value ?? null, apifyCapUsd: Number.isFinite(cap) && cap > 0 ? cap : null }
    },
    async state() {
      const rows = (await get('signal_state?id=eq.1&select=last_posts_7d_at,last_posts_48h_at,first_run_at,stopped_at,stopped_reason')) as SignalState[]
      if (!rows[0]) throw new Error('signal_state row missing')
      return rows[0]
    },
    async patchState(patch) {
      await call('PATCH', 'signal_state?id=eq.1', { ...patch, updated_at: now() })
    },
    async laneSpend(lanes, since) {
      return Number(await rpc('signal_lane_spend', { p_lanes: lanes, p_since: since })) || 0
    },
    async openApifyReservedUsd() {
      const rows = (await get('signal_spend?status=eq.reserved&lane=in.(comments_apify,reactions_apify)&select=usd')) as { usd: number | string }[]
      return rows.reduce((s, r) => s + (Number(r.usd) || 0), 0)
    },
    async insertSpend(row) {
      const out = (await call('POST', 'signal_spend?select=id', { ...row, settled_at: row.status === 'settled' ? now() : null }, 'return=representation')) as { id: number }[]
      return out[0].id
    },
    async patchSpend(id, patch, onlyIfReserved) {
      const out = (await call('PATCH', `signal_spend?id=eq.${id}${onlyIfReserved ? '&status=eq.reserved' : ''}&select=id`, patch, 'return=representation')) as unknown[]
      return out.length > 0
    },
    async reservedApifyRuns() {
      return (await get('signal_spend?lane=eq.comments_apify&status=eq.reserved&apify_run_id=not.is.null&select=*&order=id')) as SpendRow[]
    },
    async insertNotice(key, text) {
      const out = (await call('POST', 'signal_notices?on_conflict=key&select=key', { key, text }, 'resolution=ignore-duplicates,return=representation')) as unknown[]
      return out.length > 0
    },
    async upsertPosts(rows) {
      if (!rows.length) return
      const t = now()
      await call('POST', 'signal_posts?on_conflict=post_id', rows.map((r) => ({ ...r, last_count_check_at: t, updated_at: t })), 'resolution=merge-duplicates,return=minimal')
    },
    async recentPosts(since) {
      return (await get(`signal_posts?posted_at=gte.${enc(since)}&select=post_id,post_url,posted_at,likes,comment_count,comments_pulled_at_count,last_comments_pull_at,digest_status&order=posted_at.desc`)) as PostRow[]
    },
    async patchPost(postId, patch) {
      await call('PATCH', `signal_posts?post_id=eq.${enc(postId)}`, { ...patch, updated_at: now() })
    },
    async postsDigest(ids) {
      if (!ids.length) return {}
      const rows = (await get(`signal_posts?post_id=in.${enc(inList(ids))}&select=post_id,digest_status`)) as { post_id: string; digest_status: string | null }[]
      return Object.fromEntries(rows.map((r) => [r.post_id, r.digest_status]))
    },
    async peopleByKeys(ids, urls) {
      const ors = [ids.length ? `linkedin_id.in.${inList(ids)}` : '', urls.length ? `linkedin_url.in.${inList(urls)}` : ''].filter(Boolean)
      if (!ors.length) return []
      return (await get(`signal_people?or=${enc(`(${ors.join(',')})`)}&select=*`)) as Person[]
    },
    async reactorsByKeys(ids, urls) {
      const ors = [ids.length ? `linkedin_id.in.${inList(ids)}` : '', urls.length ? `linkedin_url.in.${inList(urls)}` : ''].filter(Boolean)
      if (!ors.length) return []
      return (await get(`influencer_reactors?or=${enc(`(${ors.join(',')})`)}&select=linkedin_id,linkedin_url,verdict,exported_at`)) as KnownReactor[]
    },
    async lumeLinkedinUrls(urls) {
      if (!urls.length) return []
      const q = `linkedin_url=in.${enc(inList(urls))}&select=linkedin_url`
      const [a, b] = await Promise.all([get(`lume_portal_leads?${q}`), get(`lume_portal_linkedin_leads?${q}`)])
      return [...a, ...b].map((r) => (r as { linkedin_url: string }).linkedin_url)
    },
    async lumeLinkedinKeys(keys) {
      if (!keys.length) return []
      const rows = (await get(`lead_review_items?linkedin_key=in.${enc(inList(keys))}&select=linkedin_key&limit=1000`)) as { linkedin_key: string }[]
      return rows.map((r) => r.linkedin_key)
    },
    async insertPerson(row) {
      try {
        await call('POST', 'signal_people', row)
        return 'inserted'
      } catch (err) {
        if ((err as { status?: number }).status === 409) return 'conflict'
        throw err
      }
    },
    async patchPerson(id, patch, stage) {
      const out = (await call('PATCH', `signal_people?id=eq.${id}${stage ? `&stage=eq.${stage}` : ''}&select=id`, { ...patch, updated_at: now() }, 'return=representation')) as unknown[]
      return out.length > 0
    },
    async peopleAt(stage, kind, limit) {
      return (await get(`signal_people?stage=eq.${stage}&kind=eq.${kind}&select=*&order=id&limit=${limit}`)) as Person[]
    },
  }
}
