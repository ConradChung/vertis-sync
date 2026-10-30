// The POST /leads body instantly-rotate sends for one queued lead_bank row. Pure, so it is tested without
// loading index.ts (which pulls supabase-js from npm at import).
import { fallbackJurisdictionLine, type JurisdictionRow, jurisdictionLine, resolveJurisdiction } from "../_shared/research/jurisdiction.ts";

/**
 * The POST /leads body for one queued lead_bank row. location and Operating Cities Copied are as before;
 * jurisdiction_line is always set: the row's own jurisdiction_line when present, else the active jurisdiction's
 * copy_hook for its country/region (resolved now, so activating a row applies to leads already queued), else
 * the campaign's SOP fallback sentence (_shared/research/jurisdiction.ts).
 */
// deno-lint-ignore no-explicit-any
export function rotateLeadBody(q: any, campaign: string, jurisdictions: JurisdictionRow[]) {
  const line = String(q.jurisdiction_line ?? "").trim()
    || jurisdictionLine(resolveJurisdiction(q.country, q.region, jurisdictions), fallbackJurisdictionLine(campaign));
  return { campaign, email: q.email, first_name: q.first_name, last_name: q.last_name,
    company_name: q.company_name, website: q.website, personalization: q.personalization,
    custom_variables: { location: q.location, "Operating Cities Copied": q.operating_cities, jurisdiction_line: line }, skip_if_in_workspace: true };
}
