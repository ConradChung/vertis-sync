import { z } from 'zod'
import { ruleFilterSchema } from '@/lib/rules/filter'
import { isValidRuleCron } from '@/lib/rules/nextRun'

/**
 * Request bodies for `/api/rules`. `active` is accepted in the schema only so
 * the route can refuse `true` with a precise error: a rule becomes active
 * solely through a confirmed `pending_actions(kind='activate_rule')`.
 * `active: false` (pause) is allowed — stopping never needs a tap.
 */

/** Instantly campaign ids are uuids; gmail/muse rows use short slugs. No quotes, commas or dots (PostgREST or() grammar). */
export const CAMPAIGN_ID_RE = /^[A-Za-z0-9_:-]{1,80}$/

export const ACTIVATE_VIA_ACTION = 'activate_via_action'

const fields = {
  name: z.string().trim().min(1).max(80),
  campaign_id: z.string().trim().regex(CAMPAIGN_ID_RE),
  filter: ruleFilterSchema,
  daily_cap: z.number().int().min(1).max(1000),
  order_by: z.enum(['newest', 'oldest']),
  cron: z
    .string()
    .trim()
    .refine((c) => isValidRuleCron(c), { message: 'five-field cron, at most every 15 minutes' }),
  active: z.boolean().optional(),
}

export const createRuleSchema = z.strictObject({
  ...fields,
  filter: fields.filter.optional().default({}),
  daily_cap: fields.daily_cap.optional().default(40),
  order_by: fields.order_by.optional().default('newest'),
})

export const updateRuleSchema = z
  .strictObject({
    name: fields.name.optional(),
    campaign_id: fields.campaign_id.optional(),
    filter: fields.filter.optional(),
    daily_cap: fields.daily_cap.optional(),
    order_by: fields.order_by.optional(),
    cron: fields.cron.optional(),
    active: fields.active,
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'empty patch' })

export type CreateRuleBody = z.infer<typeof createRuleSchema>
export type UpdateRuleBody = z.infer<typeof updateRuleSchema>
