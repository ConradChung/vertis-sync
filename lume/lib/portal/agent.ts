import 'server-only'
import { z } from 'zod'
import type Anthropic from '@anthropic-ai/sdk'
import type { PortalUser } from '@/lib/portal/access'
import type { PortalAgentMessage, PortalAgentResponse, PortalLead, PortalTab } from '@/lib/portal/types'
import type { PortalSearchOptions } from '@/lib/portal/leads'

/**
 * The portal's lead-lookup assistant: one read-only client tool
 * (`search_leads`) bound to the portal user's own scoped search, a manual
 * tool loop (max 4 model calls), nothing that writes or sends.
 */

export const PORTAL_AGENT_MODEL = 'claude-haiku-5-5'
export const PORTAL_AGENT_MAX_ITERATIONS = 4
export const PORTAL_AGENT_MAX_MESSAGES = 12
export const PORTAL_AGENT_MAX_CHARS = 2000
export const PORTAL_AGENT_MAX_BODY_BYTES = 20 * 1024
export const PORTAL_AGENT_MAX_LEADS = 20

export const REFUSAL_REPLY = "Sorry, I can't help with that. I can look up leads in your call list."
export const INCOMPLETE_REPLY = "I couldn't finish that search. Try a shorter or more specific question."

export const SEARCH_LEADS_TOOL: Anthropic.Messages.Tool = {
  name: 'search_leads',
  description:
    "Search this team's call list (read-only). Returns matching leads with name, title, company, phone, email, location, region and campaign. " +
    'q matches name, company, email, title, phone or city. tab "email" (default) is the email-campaign list; "linkedin" is the LinkedIn outreach list; "sheet" is the call sheets (businesses from Google Maps, with phone, rating and status). limit is 1-20 (default 10).',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      q: { type: 'string', description: 'Free text: a name, company, title, email, phone or city.' },
      region: { type: 'string', description: 'Exact region name (email tab only).' },
      has_phone: { type: 'boolean', description: 'Only leads with a phone number.' },
      tab: { type: 'string', enum: ['email', 'linkedin', 'sheet'] },
      limit: { type: 'integer', description: 'How many leads to return, 1-20.' },
    },
    additionalProperties: false,
  },
}

/** Server-side validation of the tool input (never trust the model either). */
export const SearchLeadsInput = z
  .object({
    q: z.string().max(200).optional(),
    region: z.string().max(100).optional(),
    has_phone: z.boolean().optional(),
    tab: z.enum(['email', 'linkedin', 'sheet']).optional(),
    limit: z.number().int().optional(),
  })
  .strict()
  .transform((v) => ({
    q: v.q?.trim() || undefined,
    region: v.region?.trim() || undefined,
    has_phone: v.has_phone,
    tab: (v.tab ?? 'email') as PortalTab,
    limit: Math.min(PORTAL_AGENT_MAX_LEADS, Math.max(1, v.limit ?? 10)),
  }))

export const PortalAgentBody = z.object({
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() }))
    .min(1)
    .max(200),
})

/**
 * Trim the conversation the client sent: last 12 messages, each ≤ 2,000
 * chars, starting with a user turn and ending with one (null when it cannot).
 */
export function capMessages(messages: PortalAgentMessage[]): PortalAgentMessage[] | null {
  const tail = messages
    .slice(-PORTAL_AGENT_MAX_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content.slice(0, PORTAL_AGENT_MAX_CHARS).trim() }))
    .filter((m) => m.content.length > 0)
  while (tail.length && tail[0].role !== 'user') tail.shift()
  if (!tail.length || tail[tail.length - 1].role !== 'user') return null
  return tail
}

export function portalSystemPrompt(client: string): string {
  return [
    `You help ${client}'s team find leads in their call list.`,
    'Use only the search_leads tool to look leads up; answer only from what it returns.',
    'Never invent or guess contact details (names, phones, emails, companies). If a search finds nothing, say so.',
    'You are read-only: you cannot change, add, delete, export or send anything, and cannot contact anyone.',
    'Keep answers short: a sentence or two, and let the lead cards shown under your reply carry the details.',
  ].join('\n')
}

export type PortalSearchFn = (opts: PortalSearchOptions) => Promise<{ rows: PortalLead[]; total: number }>

type MessagesClient = { messages: { create: (body: Anthropic.Messages.MessageCreateParamsNonStreaming) => Promise<Anthropic.Messages.Message> } }

/** What the model sees for each lead (no internal ids). */
function toolLead(l: PortalLead) {
  return {
    name: l.name,
    title: l.title,
    company: l.company,
    phone: l.phone,
    phone_type: l.phone_type,
    email: l.email,
    city: l.city,
    state: l.state,
    region: l.region,
    timezone: l.timezone,
    campaign: l.campaign,
    reply_status: l.reply_status,
    ...(l.step ? { status: l.step } : {}),
    ...(l.rating != null ? { rating: l.rating } : {}),
    ...(l.category ? { category: l.category } : {}),
  }
}

const textOf = (m: Anthropic.Messages.Message) =>
  m.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()

/**
 * Run the assistant for one portal user. `search` must already be bound to
 * that user (the route passes `searchPortalLeads(db, user, …)`).
 */
export async function runPortalAgent(args: {
  client: MessagesClient
  user: PortalUser
  messages: PortalAgentMessage[]
  search: PortalSearchFn
}): Promise<PortalAgentResponse> {
  const convo: Anthropic.Messages.MessageParam[] = args.messages.map((m) => ({ role: m.role, content: m.content }))
  let leads: PortalLead[] = []

  for (let i = 0; i < PORTAL_AGENT_MAX_ITERATIONS; i++) {
    const res = await args.client.messages.create({
      model: PORTAL_AGENT_MODEL,
      max_tokens: 2048,
      output_config: { effort: 'low' },
      system: portalSystemPrompt(args.user.client),
      tools: [SEARCH_LEADS_TOOL],
      tool_choice: { type: 'auto' },
      messages: convo,
    })

    if (res.stop_reason === 'refusal') return { reply: REFUSAL_REPLY, leads: [] }
    const toolUses = res.content.filter((b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use')
    if (res.stop_reason !== 'tool_use' || toolUses.length === 0) {
      return { reply: textOf(res) || INCOMPLETE_REPLY, leads }
    }

    const results: Anthropic.Messages.ToolResultBlockParam[] = []
    for (const tu of toolUses) {
      if (tu.name !== SEARCH_LEADS_TOOL.name) {
        results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: 'Unknown tool.' })
        continue
      }
      const input = SearchLeadsInput.safeParse(tu.input)
      if (!input.success) {
        results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: 'Invalid input for search_leads.' })
        continue
      }
      try {
        const { limit, ...filters } = input.data
        const found = await args.search({ ...filters, page: 1, pageSize: limit })
        leads = found.rows.slice(0, PORTAL_AGENT_MAX_LEADS)
        results.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify({ total_matches: found.total, returned: leads.length, leads: leads.map(toolLead) }),
        })
      } catch {
        results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: 'Search failed. Try again.' })
      }
    }
    convo.push({ role: 'assistant', content: res.content })
    convo.push({ role: 'user', content: results })
  }

  return { reply: INCOMPLETE_REPLY, leads }
}
