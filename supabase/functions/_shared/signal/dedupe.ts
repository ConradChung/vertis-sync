// GTM-14: dedupe commenters before any spend. Key: LinkedIn id, falling back
// to the normalized profile URL. Anyone already known is inserted once as
// stage 'skipped' (never reconsidered); an un-alerted reactor who comments is
// upgraded to a commenter ("commenter wins").
import { type Commenter, linkedinKey, profileSlug } from './comments.ts'
import type { KnownReactor, Person, Store } from './store.ts'

export type SkipReason = 'known_in_lume' | 'exported'

export interface Lookups {
  people: Person[]
  reactors: KnownReactor[]
  lumeUrls: Set<string>
  lumeKeys: Set<string>
  /** signal_posts.digest_status by post_id, for existing reactor rows. */
  digest: Record<string, string | null>
}

export type Decision =
  | { action: 'existing'; person: Person }
  | { action: 'upgrade'; person: Person }
  | { action: 'skip'; reason: SkipReason }
  | { action: 'new' }

/** Every URL spelling another table may hold for one profile (all lowercase slugs). */
export function urlVariants(url: string): string[] {
  const slug = profileSlug(url)
  if (!slug) return [url]
  const s = encodeURIComponent(slug)
  const out = new Set<string>([url])
  for (const host of ['https://www.linkedin.com', 'https://linkedin.com', 'http://www.linkedin.com', 'http://linkedin.com']) {
    out.add(`${host}/in/${s}`)
    out.add(`${host}/in/${s}/`)
  }
  return [...out]
}

const sameUrl = (a: string | null | undefined, b: string | null | undefined) => {
  const x = profileSlug(a)
  return !!x && x === profileSlug(b)
}

export function decide(c: Commenter, l: Lookups): Decision {
  const person = l.people.find((p) => (c.linkedin_id && p.linkedin_id === c.linkedin_id) || sameUrl(p.linkedin_url, c.linkedin_url))
  if (person) {
    const digestPosted = person.post_id ? l.digest[person.post_id] === 'posted' : false
    if (person.kind === 'reactor' && person.alert_status === null && !digestPosted && person.stage !== 'skipped') {
      return { action: 'upgrade', person }
    }
    return { action: 'existing', person }
  }
  const reactor = l.reactors.find((r) => (c.linkedin_id && r.linkedin_id === c.linkedin_id) || sameUrl(r.linkedin_url, c.linkedin_url))
  if (reactor && reactor.exported_at) return { action: 'skip', reason: 'exported' }
  if (reactor && reactor.verdict) return { action: 'skip', reason: 'known_in_lume' }
  const slug = profileSlug(c.linkedin_url)
  if ([...l.lumeUrls].some((u) => profileSlug(u) === slug && !!slug)) return { action: 'skip', reason: 'known_in_lume' }
  const key = linkedinKey(c.linkedin_url)
  if (key && l.lumeKeys.has(key)) return { action: 'skip', reason: 'known_in_lume' }
  return { action: 'new' }
}

export async function lookups(store: Store, cs: Commenter[]): Promise<Lookups> {
  const ids = [...new Set(cs.map((c) => c.linkedin_id).filter((x): x is string => !!x))]
  const urls = [...new Set(cs.map((c) => c.linkedin_url))]
  const variants = [...new Set(urls.flatMap(urlVariants))]
  const keys = [...new Set(urls.map(linkedinKey).filter((x): x is string => !!x))]
  const [people, reactors, lumeUrls, lumeKeys] = await Promise.all([
    store.peopleByKeys(ids, urls),
    store.reactorsByKeys(ids, variants),
    store.lumeLinkedinUrls(variants),
    store.lumeLinkedinKeys(keys),
  ])
  const postIds = [...new Set(people.map((p) => p.post_id).filter((x): x is string => !!x))]
  const digest = await store.postsDigest(postIds)
  return { people, reactors, lumeUrls: new Set(lumeUrls), lumeKeys: new Set(lumeKeys), digest }
}

export interface DedupeCounts { new: number; skipped: number; existing: number; upgraded: number }

/** Write the commenters of one post: new rows at 'triage', known ones as 'skipped', reactors upgraded. */
export async function dedupeCommenters(store: Store, cs: Commenter[], postId: string): Promise<DedupeCounts> {
  const out: DedupeCounts = { new: 0, skipped: 0, existing: 0, upgraded: 0 }
  if (!cs.length) return out
  const l = await lookups(store, cs)
  for (const c of cs) {
    const d = decide(c, l)
    const comment = { post_id: c.post_id ?? postId, comment_text: c.comment_text, comment_url: c.comment_url, commented_at: c.commented_at }
    if (d.action === 'existing') {
      out.existing++
      continue
    }
    if (d.action === 'upgrade') {
      const p = d.person
      const patch: Partial<Person> = {
        kind: 'commenter', ...comment, post_id: postId,
        name: p.name ?? c.name, first_name: p.first_name ?? c.first_name, headline: p.headline ?? c.headline,
        linkedin_id: p.linkedin_id ?? c.linkedin_id,
      }
      // A reactor's ready drafts carry the reactor opening: rebuild them.
      if (p.stage === 'ready') patch.stage = 'draft'
      if (await store.patchPerson(p.id, patch, p.stage)) out.upgraded++
      continue
    }
    const row: Partial<Person> = {
      linkedin_id: c.linkedin_id, linkedin_url: c.linkedin_url, name: c.name, first_name: c.first_name, headline: c.headline,
      kind: 'commenter', ...comment, post_id: postId,
      stage: d.action === 'skip' ? 'skipped' : 'triage',
      skip_reason: d.action === 'skip' ? d.reason : null,
    }
    const r = await store.insertPerson(row)
    if (r === 'conflict') out.existing++
    else if (d.action === 'skip') out.skipped++
    else out.new++
  }
  return out
}
