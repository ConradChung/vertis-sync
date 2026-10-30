import { z } from 'zod'

/** Shapes shared by the influencer routes and the agent's tools (match the DB checks). */
export const Slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lowercase-words-with-dashes').max(80)
/** Transform-free (the agent's tool schemas must convert to JSON Schema); strip the trailing slash with `profileUrl`. */
export const LinkedinProfileUrlRaw = z
  .string()
  .max(300)
  .regex(/^https:\/\/(www\.)?linkedin\.com\/in\/[^/?#\s]+\/?$/, 'a https://www.linkedin.com/in/<profile> URL')
export const profileUrl = (u: string) => u.trim().replace(/\/+$/, '')
export const LinkedinProfileUrl = LinkedinProfileUrlRaw.transform(profileUrl)
export const LookbackDays = z.number().int().min(7).max(730)
export const MaxReactionsPerPost = z.number().int().min(1).max(1000)
export const MaxVerifyUsd = z.number().positive().max(50)

export const NewInfluencerBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    slug: Slug.optional(),
    linkedin_url: LinkedinProfileUrl,
    lookback_days: LookbackDays.optional(),
    max_reactions_per_post: MaxReactionsPerPost.optional(),
    notes: z.string().trim().max(1000).optional(),
  })
  .strict()

export const InfluencerPatchBody = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    linkedin_url: LinkedinProfileUrl.optional(),
    lookback_days: LookbackDays.optional(),
    max_reactions_per_post: MaxReactionsPerPost.optional(),
    active: z.boolean().optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
  })
  .strict()
  .refine((p) => Object.values(p).some((v) => v !== undefined), 'nothing to update')

export const ExportBody = z
  .object({
    min_door_count: z.number().int().min(0).max(1_000_000).optional(),
    only_new: z.boolean().optional(),
    verified_only: z.boolean().optional(),
    run_id: z.string().uuid().optional(),
    influencer_slugs: z.array(Slug).max(100).optional(),
    door_count_column: z.boolean().optional(),
    reacted_to_column: z.boolean().optional(),
  })
  .strict()

/** "Jennifer Ruelens (PM Jen)" → "jennifer-ruelens". */
export function slugFromName(name: string): string {
  return name
    .replace(/\([^)]*\)/g, ' ')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '')
}
