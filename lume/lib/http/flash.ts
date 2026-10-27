/**
 * The `?flash=` / `?flash_error=` codes a plain-form post sends back to
 * /operator (lib/http/form.ts). The page only ever shows the fixed text for
 * a known code, never the query string itself, so a crafted link cannot put
 * words on the page the bot would act on. Pure.
 */

export const FLASH_OK = {
  done: 'Done.',
  decided: 'Decision sent.',
  still_working: 'Sent; the pipeline is still working. Re-check on the next visit.',
  denied: 'Denied.',
  approved_running: 'Approved; it is running now. Its result appears under Recent outcomes.',
  approved_ran: 'Approved and done.',
  approved: 'Approved.',
  filed: 'Filed; it now needs confirmation (Approve it below).',
  campaign_set: 'Campaign set.',
  acked: 'Alerts acknowledged.',
  apollo_received: 'Apollo link received; choose the count under Needs confirmation.',
} as const

export const FLASH_ERROR = {
  invalid_body: 'That form was not valid; nothing happened.',
  too_large: 'That was too large; nothing happened.',
  already_handled: 'Already handled elsewhere; nothing changed.',
  not_found: 'Not found; it may already be gone.',
  db_error: 'Lume could not reach its database; try again.',
  needs_confirmation: 'That step needs its own confirmation.',
  bad_callback_data: 'That button is not valid.',
  pipeline_error: 'The pipeline returned an error; try again or tell Conrad.',
  pipeline_not_configured: 'The pipeline entrypoint is not configured; tell Conrad.',
  approved_failed: 'Approved, but it failed. See Recent outcomes.',
  approved_retry: 'Approved, but it could not finish; it will be retried.',
  key_on_action_page: 'Decide this on its action page: its sign-in link is shown once there.',
  master_only: 'Only the master bot or the owner can issue keys or manage verticals.',
  several_matches: 'Several campaigns match; pick one from the list.',
  no_campaign_match: 'No campaign matched that name.',
  unknown_campaign: 'That campaign does not exist in Instantly.',
  instantly_not_configured: 'Instantly is not configured; tell Conrad.',
  instantly_unreachable: 'Instantly did not answer; try again shortly.',
  invalid_apollo_url: 'That is not an Apollo people-search link.',
  duplicate: 'The same request is already waiting for confirmation.',
  invalid_payload: 'That request was not valid.',
  job_not_ready: 'That job is not ready for this step.',
  job_not_found: 'That job no longer exists.',
  nothing_to_push: 'Nothing is left to push.',
  no_campaign: 'The job has no campaign yet.',
  preview_failed: 'The push preview failed; try again.',
} as const

export type FlashOk = keyof typeof FLASH_OK
export type FlashError = keyof typeof FLASH_ERROR

const has = <T extends object>(o: T, k: string | null): k is Extract<keyof T, string> => !!k && Object.prototype.hasOwnProperty.call(o, k)

/** The page text for the query's flash codes; unknown codes give a generic line, never the raw value. */
export function flashMessages(ok: string | null, error: string | null): { ok: string | null; error: string | null } {
  return {
    ok: ok ? (has(FLASH_OK, ok) ? FLASH_OK[ok] : FLASH_OK.done) : null,
    error: error ? (has(FLASH_ERROR, error) ? FLASH_ERROR[error] : 'That did not work.') : null,
  }
}
