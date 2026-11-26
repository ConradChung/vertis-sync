import { DECISION_MAKER_CASCADE, personLinkedinUrl, type BlitzSession, type UnavailableReason } from '@/lib/blitz'

/**
 * GTM-19 contact lookup (Blitz), run only for a row that passed the exclusions,
 * the duplicate check and the PM check, i.e. a row about to reach the sheet.
 * One contact per company at most:
 *
 *  - The row names a person with a LinkedIn profile (hiring lane: the job
 *    poster; new_manager: the new hire) → their verified work email.
 *    1 record when found, 0 on a miss.
 *  - Company only → Waterfall ICP on the company's LinkedIn page (from the row,
 *    else Domain to LinkedIn) for ONE decision-maker in the owner's title
 *    order, then that person's work email. At most 3 records (domain 1 +
 *    waterfall 1 + email 1); started only while 3 are left.
 *
 * Never throws: a missing key, exhausted records or an outage leaves the row
 * without a contact, exactly as before.
 */

export type ContactSource = 'person' | 'waterfall'

export interface HiringContact {
  contact_name: string | null
  contact_title: string | null
  contact_linkedin: string | null
  contact_email: string | null
  contact_source: ContactSource
}

export interface ContactRow {
  company_domain: string | null
  company_website: string | null
  company_linkedin: string | null
  person_name: string | null
  person_title: string | null
  person_linkedin: string | null
}

export type ContactResult = { kind: 'found'; contact: HiringContact } | { kind: 'miss' } | { kind: 'unavailable'; reason: UnavailableReason }

/** The session methods this needs (BlitzSession; tests pass a fake). */
export type ContactBlitz = Pick<BlitzSession, 'canSpend' | 'findWorkEmail' | 'domainToLinkedin' | 'waterfallIcp'>

/** Worst case for the company-only path (domain → waterfall → email). */
export const COMPANY_PATH_MAX_RECORDS = 3

const companyLinkedinUrl = (raw: string | null): string | null => {
  const s = raw?.trim()
  return s && /linkedin\.com\/company\//i.test(s) ? s : null
}

export async function findHiringContact(b: ContactBlitz, r: ContactRow): Promise<ContactResult> {
  const person = personLinkedinUrl(r.person_linkedin)
  if (person) {
    if (!(await b.canSpend(1))) return { kind: 'unavailable', reason: 'exhausted' }
    const e = await b.findWorkEmail(person)
    if (e.kind !== 'found') return e
    return { kind: 'found', contact: { contact_name: r.person_name, contact_title: r.person_title, contact_linkedin: r.person_linkedin, contact_email: e.email, contact_source: 'person' } }
  }

  let company = companyLinkedinUrl(r.company_linkedin)
  const domain = r.company_domain ?? r.company_website
  if (!company && !domain) return { kind: 'miss' }
  if (!(await b.canSpend(company ? COMPANY_PATH_MAX_RECORDS - 1 : COMPANY_PATH_MAX_RECORDS))) return { kind: 'unavailable', reason: 'exhausted' }
  if (!company) {
    const c = await b.domainToLinkedin(domain!)
    if (c.kind !== 'found') return c
    company = c.companyLinkedinUrl
  }
  const icp = await b.waterfallIcp(company, DECISION_MAKER_CASCADE, 1)
  if (icp.kind !== 'found') return icp
  const p = icp.people[0]
  const e = await b.findWorkEmail(p.linkedinUrl)
  if (e.kind === 'unavailable') return e
  // A decision-maker without a verified email is still worth showing (name + LinkedIn).
  return {
    kind: 'found',
    contact: { contact_name: p.name || null, contact_title: p.title, contact_linkedin: p.linkedinUrl, contact_email: e.kind === 'found' ? e.email : null, contact_source: 'waterfall' },
  }
}
