import { z } from 'zod'
import { INTEREST, REPLY_CATEGORIES, VERDICTS } from '@/lib/inbox/model'

/**
 * Request schemas shared by the inbox routes (/api/inbox/*) and the agent's
 * inbox tools, so a bot, the owner and the agent are validated the same way.
 * Pure and transform-free (the agent's tool schemas become JSON Schema).
 */

export const EmailId = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/, 'email id')
export const CampaignId = z.string().regex(/^[A-Za-z0-9_:-]{1,80}$/, 'campaign id')
const LeadEmail = z.email().max(320)

export const INTEREST_NAMES = Object.keys(INTEREST) as [keyof typeof INTEREST, ...(keyof typeof INTEREST)[]]

/** Which reply / lead a write is about: an email id, or the lead + its campaign. */
const target = {
  reply_to_uuid: EmailId.optional().describe('Instantly email id of the reply (from list_replies / get_thread)'),
  lead_email: LeadEmail.optional(),
  campaign_id: CampaignId.optional(),
}
const hasTarget = (v: { reply_to_uuid?: string; lead_email?: string; campaign_id?: string }) => !!v.reply_to_uuid || (!!v.lead_email && !!v.campaign_id)
const TARGET_MSG = 'reply_to_uuid, or lead_email + campaign_id'

export const LabelBody = z
  .strictObject({
    ...target,
    category: z.enum(REPLY_CATEGORIES).optional(),
    verdict: z.enum(VERDICTS).optional(),
    block: z.boolean().optional().describe('BAD only: also add the address to the Instantly blocklist'),
    note: z.string().trim().max(1000).optional().describe('one line for the CRM, e.g. a return date for ooo'),
  })
  .refine(hasTarget, TARGET_MSG)
  .refine((v) => !!v.category || v.verdict === 'BAD', 'a category, or verdict BAD')
export type LabelInput = z.infer<typeof LabelBody>

export const BookingBody = z
  .strictObject({
    ...target,
    time: z.iso.datetime({ offset: true }).describe('meeting start, ISO 8601 with offset'),
    event_id: z.string().trim().min(1).max(300).optional(),
    event_link: z.url().max(2000).optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .refine(hasTarget, TARGET_MSG)
export type BookingInput = z.infer<typeof BookingBody>

export const DraftBody = z.strictObject({
  reply_to_uuid: EmailId,
  body: z.string().trim().min(1).max(20_000),
  subject: z.string().trim().max(300).optional(),
  verdict: z.enum(VERDICTS).optional(),
  proposed_times: z.array(z.string().trim().min(1).max(120)).max(10).optional(),
  research_note: z.string().trim().max(2000).optional(),
})
export type DraftInput = z.infer<typeof DraftBody>

export const RuleBody = z.strictObject({
  file: z.string().trim().min(1).max(120).regex(/^[^/\\]+$/, 'a file name, not a path'),
  rule: z.string().trim().min(1).max(1000),
})
