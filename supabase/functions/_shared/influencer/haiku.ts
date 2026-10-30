// Haiku structured-output request / response for the influencer pipeline.
// Pure: the caller does the fetch. Structured outputs (output_config.format),
// as in the Python port; low effort (classification and parsing).

export const HAIKU_MODEL = 'claude-haiku-5-5'

export interface JsonRequest {
  model: string
  max_tokens: number
  system: string
  output_config: { effort: 'low'; format: { type: 'json_schema'; schema: Record<string, unknown> } }
  messages: Array<{ role: 'user'; content: string }>
}

export function buildJsonRequest(system: string, user: string, schema: Record<string, unknown>, maxTokens = 4096): JsonRequest {
  return {
    model: HAIKU_MODEL,
    max_tokens: maxTokens,
    system,
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: user }],
  }
}

export interface Usage { input_tokens?: number; output_tokens?: number }

/** The JSON of the response's text block; throws when truncated, refused or not JSON. */
export function parseJsonResponse(body: unknown): { json: unknown; usage: Usage | null } {
  const b = (body && typeof body === 'object' ? body : {}) as { stop_reason?: string; content?: unknown; usage?: Usage }
  if (b.stop_reason === 'max_tokens') throw new Error('haiku response truncated at max_tokens')
  if (b.stop_reason === 'refusal') throw new Error('haiku refusal')
  const blocks = Array.isArray(b.content) ? b.content as Array<{ type?: string; text?: string }> : []
  const text = blocks.find((x) => x?.type === 'text' && typeof x.text === 'string')?.text
  if (!text) throw new Error('haiku response has no text block')
  return { json: JSON.parse(text), usage: b.usage ?? null }
}
