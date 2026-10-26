/** Instantly campaign ids are uuids; accept any id-safe token, refuse anything else. */
const CAMPAIGN_ID_RE = /^[A-Za-z0-9_-]{1,100}$/

export function campaignIdParam(v: string | undefined): string | null {
  return v && CAMPAIGN_ID_RE.test(v) ? v : null
}
