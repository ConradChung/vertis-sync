/**
 * Built-in skills: pipelines that ship with Lume (not saved by the owner).
 * They show wherever saved skills are listed (list_skills, the Skills menu)
 * and can be run or attached like a saved skill, but they cannot be renamed
 * or deleted, and running one does not bump a run count. Pure and client-safe.
 */
import type { Skill } from '@/lib/agent/skillModel'

export const PM_INFLUENCER_SKILL_ID = '00000000-0000-4000-8000-00000000f1e1'

export interface BuiltinSkill extends Skill {
  builtin: true
}

export const PM_INFLUENCER_SKILL: BuiltinSkill = {
  id: PM_INFLUENCER_SKILL_ID,
  builtin: true,
  name: 'PM influencer reactions → Apollo CSV',
  description:
    'Decision makers at property management companies, found among the people who react to PM influencers\' LinkedIn posts. ' +
    'Posts → top 10 PM posts → reactions → dedupe → Haiku triage → Perplexity verify + door count → an Apollo contact-import CSV ' +
    '(Conrad imports it into Apollo, opens the list as a people search and pastes the search URL back for a Leadsfriday order). ' +
    'Last full run (2026-10-08, 26 influencers): ~$37, 254 verified, 97 at 700+ doors.',
  steps: [
    { type: 'note', text: 'list_influencers, then estimate_influencer_run for the chosen influencers (skip the zero-yield ones); quote the posts cost now, the reactions and Perplexity ranges and the expected leads.' },
    { type: 'note', text: 'start_influencer_run (approval 1): posts scrape + Haiku top-10 ranking; the run stops after top posts with the exact reactions bill.' },
    { type: 'note', text: 'get_influencer_run until it is awaiting_approval, show the exact bill per influencer, then approve_reactions (approval 2): reactions, triage, Perplexity verify capped at max_verify_usd, door-count retry.' },
    { type: 'note', text: 'get_influencer_run until done; report verified leads, 700+ count, new vs known reactors and the actual cost per vendor.' },
    { type: 'note', text: 'export_influencer_csv (e.g. min_door_count 700, only_new): give the download link and the Apollo steps (import into a list, open it as a people search, copy the URL).' },
    { type: 'note', text: 'When Conrad pastes the Apollo search URL: create_order (Leadsfriday; nothing is spent until he picks a count).' },
  ],
  variables: [],
  source_conversation_id: null,
  created_at: '2026-10-30T00:00:00.000Z',
  updated_at: '2026-10-30T00:00:00.000Z',
  last_run_at: null,
  run_count: 0,
}

export const BUILTIN_SKILLS: readonly BuiltinSkill[] = [PM_INFLUENCER_SKILL]

export function builtinSkillById(id: string): BuiltinSkill | null {
  return BUILTIN_SKILLS.find((s) => s.id === id.toLowerCase()) ?? null
}

/** Case-insensitive; also "pm influencer reactions" and "pm influencer". */
export function builtinSkillByName(name: string): BuiltinSkill | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return BUILTIN_SKILLS.find((s) => s.name.toLowerCase() === n || (n.length >= 6 && s.name.toLowerCase().startsWith(n))) ?? null
}
