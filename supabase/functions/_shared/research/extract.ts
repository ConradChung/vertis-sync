// Haiku extraction request / response (research P2). Pure: the caller does the fetch.
//
// Forced tool use (`record_facts`) with an enum-constrained schema, so the
// model's output is structured; verify.ts then keeps only values whose
// snippet is verbatim on the cited page.

import type { Page } from './pms.ts'
import { type Candidate, EXTRACT_FIELDS } from './verify.ts'

export const EXTRACT_MODEL = 'claude-haiku-5-5'
export const EXTRACT_TOOL = 'record_facts'
export const PROMPT_PAGE_CHARS = 12_000
const PROMPT_TOTAL_CHARS = 60_000

export const EXTRACT_SYSTEM = [
  'You extract facts about a property management company from the text of its own website.',
  `Call ${EXTRACT_TOOL} exactly once with every fact you can support. Fields:`,
  '- door_count: how many units / doors / homes / properties the company manages, as an integer (e.g. "1,237 doors" -> 1237). Only a number the site states; never estimate or add numbers up.',
  '- after_hours: true if the site states after-hours / 24/7 / emergency maintenance coverage, false only if it explicitly says there is none.',
  '- city: the city of the company\'s main office or primary market, written exactly as on the page.',
  '- region: the state / province / emirate / county of that city, written exactly as on the page (abbreviation if the page abbreviates).',
  '- country: the country (full English name). May be inferred from the region or address.',
  'For each fact give: snippet = a short passage (one sentence or address line, under 200 characters) copied VERBATIM, character for character, from the page text; source_url = the url attribute of the <page> the snippet is from; confidence = high if the page states it directly, medium if it needs light interpretation, low if uncertain.',
  'Never paraphrase or fix typos in a snippet. Never use a snippet from one page with another page\'s url. Omit any field the pages do not support.',
].join('\n')

export interface MessagesRequest {
  model: string
  max_tokens: number
  system: string
  tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>
  tool_choice: { type: 'tool'; name: string }
  messages: Array<{ role: 'user'; content: string }>
}

export function buildExtractionRequest(domain: string, pages: Page[]): MessagesRequest {
  let budget = PROMPT_TOTAL_CHARS
  const blocks: string[] = []
  for (const p of pages) {
    if (budget <= 0) break
    const text = (p.text ?? '').slice(0, Math.min(PROMPT_PAGE_CHARS, budget))
    budget -= text.length
    blocks.push(`<page url="${p.url.replace(/"/g, '%22')}">\n${text}\n</page>`)
  }
  return {
    model: EXTRACT_MODEL,
    max_tokens: 1500,
    system: EXTRACT_SYSTEM,
    tools: [{
      name: EXTRACT_TOOL,
      description: 'Record the facts found on the company website, each with a verbatim snippet and the page URL it came from.',
      input_schema: {
        type: 'object',
        properties: {
          facts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                field: { type: 'string', enum: [...EXTRACT_FIELDS] },
                value: { type: ['integer', 'boolean', 'string'], description: 'integer for door_count, boolean for after_hours, string otherwise' },
                confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
                snippet: { type: 'string', description: 'verbatim text copied from the page' },
                source_url: { type: 'string', description: 'the url attribute of the page the snippet is from' },
              },
              required: ['field', 'value', 'confidence', 'snippet', 'source_url'],
            },
          },
        },
        required: ['facts'],
      },
    }],
    tool_choice: { type: 'tool', name: EXTRACT_TOOL },
    messages: [{ role: 'user', content: `Company website: ${domain}\n\n${blocks.join('\n\n')}` }],
  }
}

type Raw = Record<string, unknown>

export function parseExtractionResponse(body: unknown): { candidates: Candidate[]; usage: Raw | null } {
  const b = body && typeof body === 'object' ? (body as Raw) : {}
  const usage = b.usage && typeof b.usage === 'object' ? (b.usage as Raw) : null
  const content = Array.isArray(b.content) ? b.content : []
  const call = content.find((c) => c && typeof c === 'object' && (c as Raw).type === 'tool_use' && (c as Raw).name === EXTRACT_TOOL) as Raw | undefined
  const facts = call && call.input && typeof call.input === 'object' ? (call.input as Raw).facts : null
  if (!Array.isArray(facts)) return { candidates: [], usage }
  const candidates: Candidate[] = []
  for (const f of facts) {
    if (!f || typeof f !== 'object') continue
    const x = f as Raw
    if (typeof x.field !== 'string' || x.value === undefined || x.value === null) continue
    if (typeof x.snippet !== 'string' || typeof x.source_url !== 'string' || typeof x.confidence !== 'string') continue
    candidates.push({
      field: x.field as Candidate['field'],
      value: x.value,
      confidence: x.confidence as Candidate['confidence'],
      snippet: x.snippet,
      source_url: x.source_url,
    })
  }
  return { candidates, usage }
}
