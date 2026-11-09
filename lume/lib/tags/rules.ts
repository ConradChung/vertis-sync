/**
 * The auto-tag rules, as the triggers in
 * supabase/migrations/20261109092501_lume_tags.sql apply them. The database
 * is the source of truth (edge functions write these rows); this pure mirror
 * documents the precedence and is what the tests pin. Change both together.
 */

type Id = string | null | undefined

const first = (...ids: Id[]): string | null => ids.find((v): v is string => !!v) ?? null

/** lume_verticals.key handles the rules use. */
export interface TagKeys {
  jobs: Id
  hnwi: Id
  pm_reactions: Id
}

/** job_batches: always the job-search tag when inserted untagged. */
export const jobBatchTag = (own: Id, keys: TagKeys) => first(own, keys.jobs)

/** validation_jobs: its ingest's tag, else HNWI for source 'hnwi', else the vertical owning its campaign. */
export function validationJobTag(j: { own?: Id; ingest?: Id; source?: string | null; campaign?: Id; campaignNoLocation?: Id }, keys: TagKeys) {
  return first(j.own, j.ingest, j.source === 'hnwi' ? keys.hnwi : null, j.campaign, j.campaignNoLocation)
}

/** lead_review_sets: its project's tag, else influencer sheets → PM reactions, else the chat that made it. */
export function leadListTag(l: { own?: Id; project?: Id; sheetKind?: string | null; conversation?: Id }, keys: TagKeys) {
  return first(l.own, l.project, l.sheetKind === 'influencer_candidates' ? keys.pm_reactions : null, l.conversation)
}

/**
 * pending_actions: the item its payload names (job_id, target_id, list_id),
 * payload.vertical_id, the vertical owning its campaign, else the chat whose
 * agent run requested it.
 */
export function actionTag(a: { own?: Id; job?: Id; target?: Id; list?: Id; payloadVertical?: Id; campaign?: Id; sourceCampaign?: Id; conversation?: Id }) {
  return first(a.own, a.job, a.target, a.list, a.payloadVertical, a.campaign, a.sourceCampaign, a.conversation)
}

/** lume_tasks: its chat's tag, else its filed action's. */
export const taskTag = (t: { own?: Id; conversation?: Id; action?: Id }) => first(t.own, t.conversation, t.action)

/** A chat's tag: its own vertical, else its project's. */
export const conversationTag = (c: { own?: Id; project?: Id }) => first(c.own, c.project)

/**
 * Carry-down: when a parent is retagged from `oldParent` to `newParent`, a
 * child follows if it had no tag or still held what it inherited; a child
 * the owner tagged differently keeps its own.
 */
export function followParent(child: Id, oldParent: Id, newParent: Id): string | null {
  if (!child || child === oldParent) return newParent ?? null
  return child
}
