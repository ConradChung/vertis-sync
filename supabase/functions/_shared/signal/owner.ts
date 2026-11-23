// GTM-14: owner-operators (people who own rentals and manage them themselves).
// They are kept, labelled segment 'owner_operator', and carded as such. The
// shared influencer verify parse is unchanged; the signal lane asks Haiku one
// extra boolean in the same call, and the crawl worker checks their site with
// its own rules ("a real operator, not a vendor").
import { type JsonRequest } from '../influencer/haiku.ts'
import { verifyParseRequest } from '../influencer/verify.ts'

export type Segment = 'pm' | 'owner_operator'

export const OWNER_OPERATOR_RULE = `- is_owner_operator: true if the person's current company owns rental property (residential,
  multifamily or single-family rentals) and operates or self-manages it itself, rather than managing
  for third-party owners (e.g. "Multifamily Investor & Operator", a holding company running its own
  buildings). False for vendors, software, lenders, brokers who only sell, coaches, consultants, and
  passive investors in funds or REITs. Independent of is_pm_company.`

/** The influencer verify parse request plus is_owner_operator. */
export function signalVerifyParseRequest(name: string, headline: string, answer: string, citations: string[]): JsonRequest {
  const base = verifyParseRequest(name, headline, answer, citations)
  const schema = base.output_config.format.schema as { properties: Record<string, unknown>; required: string[] }
  return {
    ...base,
    system: `${base.system}\n${OWNER_OPERATOR_RULE}`,
    output_config: {
      ...base.output_config,
      format: {
        ...base.output_config.format,
        schema: { ...schema, properties: { ...schema.properties, is_owner_operator: { type: 'boolean' } }, required: [...schema.required, 'is_owner_operator'] },
      },
    },
  }
}

/** is_owner_operator from the same parse; anything but true is false. */
export const parseOwnerOperator = (json: unknown): boolean =>
  !!json && typeof json === 'object' && (json as { is_owner_operator?: unknown }).is_owner_operator === true

const q = (s: string) => s.replace(/"/g, "'").replace(/\s+/g, ' ').trim().slice(0, 200)

export function ownerDoorQuestion(company: string, location: string): string {
  return `How many rental units or doors does "${q(company)}" (${q(location)}) own or operate? Quote the exact number and cite the page.`
}

/** Crawl-worker rules for an owner-operator's site: qualify = a real rental operator, not a vendor. */
export const OWNER_OPERATOR_CRAWL_RULES =
  'Qualify companies that own and operate rental real estate themselves (residential, multifamily, ' +
  'single-family rentals or mixed-use): owner-operators and real-estate investment or holding companies ' +
  'that run their own rental properties, and property management companies. ' +
  'Disqualify: software, proptech and other vendors selling to landlords or property managers; lenders; ' +
  'brokerages that only buy/sell; contractors, maintenance, cleaning and other service vendors; coaches and consultants.'

/** The crawl verdict stored for an owner-operator the worker qualified. */
export const OWNER_OPERATOR_VERDICT = 'owner_operator'

/** The only rows that may reach 'ready': a crawl-confirmed PM, or a crawl-confirmed owner-operator. */
export function crawlPassed(p: { crawl_verdict: string | null; segment?: string | null }): boolean {
  if (p.crawl_verdict === 'property_manager') return true
  return p.segment === 'owner_operator' && p.crawl_verdict === OWNER_OPERATOR_VERDICT
}
