import { assert, assertEquals } from 'jsr:@std/assert@1'
import { buildExtractionRequest, EXTRACT_MODEL, EXTRACT_TOOL, parseExtractionResponse, PROMPT_PAGE_CHARS } from './extract.ts'

const pages = [
  { url: 'https://acme-pm.com/', text: 'We manage 1,237 doors.', links: [] },
  { url: 'https://acme-pm.com/contact', text: 'x'.repeat(PROMPT_PAGE_CHARS + 500), links: [] },
]

Deno.test('buildExtractionRequest: Haiku 5.5, forced tool use, every page with its URL', () => {
  const req = buildExtractionRequest('acme-pm.com', pages)
  assertEquals(req.model, 'claude-haiku-5-5')
  assertEquals(EXTRACT_MODEL, 'claude-haiku-5-5')
  assertEquals(req.tool_choice, { type: 'tool', name: EXTRACT_TOOL })
  assertEquals(req.tools.length, 1)
  const schema = req.tools[0].input_schema as { properties: { facts: { items: { properties: Record<string, { enum?: string[] }>; required: string[] } } } }
  const item = schema.properties.facts.items
  assertEquals(item.properties.field.enum, ['door_count', 'after_hours', 'city', 'region', 'country'])
  assertEquals(item.properties.confidence.enum, ['high', 'medium', 'low'])
  assertEquals(item.required.sort(), ['confidence', 'field', 'snippet', 'source_url', 'value'])
  const user = req.messages[0].content as string
  assert(user.includes('<page url="https://acme-pm.com/">\nWe manage 1,237 doors.\n</page>'))
  assert(user.includes('<page url="https://acme-pm.com/contact">'))
  assert(!user.includes('x'.repeat(PROMPT_PAGE_CHARS + 1)), 'each page is truncated')
  assert(/verbatim/i.test(req.system), 'the system prompt demands verbatim snippets')
})

Deno.test('parseExtractionResponse: reads the tool_use input', () => {
  const body = {
    content: [
      { type: 'text', text: 'ok' },
      {
        type: 'tool_use',
        name: EXTRACT_TOOL,
        input: {
          facts: [
            { field: 'door_count', value: 1237, confidence: 'high', snippet: 'We manage 1,237 doors', source_url: 'https://acme-pm.com/' },
            { field: 'after_hours', value: true, confidence: 'medium', snippet: '24/7', source_url: 'https://acme-pm.com/contact' },
          ],
        },
      },
    ],
    usage: { input_tokens: 1000, output_tokens: 80 },
  }
  const r = parseExtractionResponse(body)
  assertEquals(r.candidates.length, 2)
  assertEquals(r.candidates[0].field, 'door_count')
  assertEquals(r.usage, { input_tokens: 1000, output_tokens: 80 })
})

Deno.test('parseExtractionResponse: no tool call / junk -> no candidates, malformed entries skipped', () => {
  assertEquals(parseExtractionResponse({ content: [{ type: 'text', text: '{}' }] }).candidates, [])
  assertEquals(parseExtractionResponse(null).candidates, [])
  assertEquals(parseExtractionResponse({ content: [{ type: 'tool_use', name: EXTRACT_TOOL, input: { facts: 'nope' } }] }).candidates, [])
  const r = parseExtractionResponse({
    content: [{
      type: 'tool_use',
      name: EXTRACT_TOOL,
      input: { facts: [null, 'x', { field: 'city' }, { field: 'city', value: 'Burnaby', confidence: 'high', snippet: 'Burnaby, BC', source_url: 'https://a.com/' }] },
    }],
  })
  assertEquals(r.candidates.map((c) => c.value), ['Burnaby'])
})
