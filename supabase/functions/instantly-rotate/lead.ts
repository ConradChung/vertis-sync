// The POST /leads body instantly-rotate sends for one queued lead_bank row. Pure, so it is tested without
// loading index.ts (which pulls supabase-js from npm at import).
import { complianceLaw, type JurisdictionRow, resolveJurisdiction } from "../_shared/research/jurisdiction.ts";

/**
 * The POST /leads body for one queued lead_bank row. location and Operating Cities Copied are as before;
 * compliance_law is always set: the row's own lead_bank.compliance_law when present, else the short_name (or
 * compliance_name) of the active jurisdiction for its country/region (resolved now, so activating a row applies to leads already
 * queued), else the generic fallback "local landlord-tenant law" (_shared/research/jurisdiction.ts).
 */
// deno-lint-ignore no-explicit-any
export function rotateLeadBody(q: any, campaign: string, jurisdictions: JurisdictionRow[]) {
  const law = String(q.compliance_law ?? "").trim() || complianceLaw(resolveJurisdiction(q.country, q.region, jurisdictions));
  return { campaign, email: q.email, first_name: q.first_name, last_name: q.last_name,
    company_name: q.company_name, website: q.website, personalization: q.personalization,
    custom_variables: { location: q.location, "Operating Cities Copied": q.operating_cities, compliance_law: law }, skip_if_in_workspace: true };
}
