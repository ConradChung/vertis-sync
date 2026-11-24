import 'server-only'
import { datasetItems, getRun, startRun } from '@/lib/adapters/apify'
import { haikuUsd, hiringCheckQuestion, parseHiringCheck, parseRequest, perplexityRequest, PPLX_CALL_USD, PPLX_URL } from '@/lib/hiring/checkPrompt'
import { DRAFT_MAX_TOKENS, DRAFT_MODEL, DRAFT_SCHEMA, draftSystem, draftUser, type Draft } from '@/lib/hiring/draft'
import type { AiPort, ApifyPort, Deps } from '@/lib/hiring/engine'
import { extractRequest, parseExtraction } from '@/lib/hiring/extract'
import { liveStore } from '@/lib/hiring/store'

/**
 * GTM-19 live ports: Apify (lib/adapters/apify.ts, APIFY_API_TOKEN),
 * Perplexity (PERPLEXITY_API_KEY) and Haiku (ANTHROPIC_API_KEY) over fetch,
 * same request shapes as the company-check edge function. Missing keys throw,
 * so the engine leaves the row pending (retried) rather than guessing.
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'

function key(name: 'PERPLEXITY_API_KEY' | 'ANTHROPIC_API_KEY'): string {
  const v = process.env[name]?.trim()
  if (!v) throw new Error(`${name} not set`)
  return v
}

/** The JSON of a structured-output response's text block (throws when truncated, refused or not JSON). */
export function parseJsonResponse(body: unknown): { json: unknown; usage: { input_tokens?: number; output_tokens?: number } | null } {
  const b = (body && typeof body === 'object' ? body : {}) as { stop_reason?: string; content?: unknown; usage?: { input_tokens?: number; output_tokens?: number } }
  if (b.stop_reason === 'max_tokens') throw new Error('haiku response truncated')
  if (b.stop_reason === 'refusal') throw new Error('haiku refusal')
  const blocks = Array.isArray(b.content) ? (b.content as { type?: string; text?: string }[]) : []
  const text = blocks.find((x) => x?.type === 'text' && typeof x.text === 'string')?.text
  if (!text) throw new Error('haiku response has no text block')
  return { json: JSON.parse(text), usage: b.usage ?? null }
}

async function haiku(body: unknown): Promise<{ json: unknown; usd: number }> {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'x-api-key': key('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  })
  if (!res.ok) throw new Error(`anthropic HTTP ${res.status}`)
  const { json, usage } = parseJsonResponse(await res.json())
  return { json, usd: haikuUsd(usage) }
}

export const liveAi: AiPort = {
  async checkCompany(c) {
    const res = await fetch(PPLX_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key('PERPLEXITY_API_KEY')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(perplexityRequest(hiringCheckQuestion(c))),
      signal: AbortSignal.timeout(45_000),
    })
    if (!res.ok) throw new Error(`perplexity HTTP ${res.status}`)
    const b = (await res.json()) as { choices?: { message?: { content?: unknown } }[]; citations?: unknown; usage?: { cost?: { total_cost?: unknown } } }
    const answer = b.choices?.[0]?.message?.content
    if (typeof answer !== 'string') throw new Error('perplexity: no answer')
    const citations = Array.isArray(b.citations) ? b.citations.filter((x): x is string => typeof x === 'string') : []
    const pplxCost = Number(b.usage?.cost?.total_cost)
    const parsed = await haiku(parseRequest(c, answer, citations))
    return { check: parseHiringCheck(parsed.json), usd: (Number.isFinite(pplxCost) && pplxCost > 0 ? pplxCost : PPLX_CALL_USD) + parsed.usd }
  },

  async draft(c) {
    const r = await haiku({
      model: DRAFT_MODEL,
      max_tokens: DRAFT_MAX_TOKENS,
      system: draftSystem(),
      output_config: { effort: 'low', format: { type: 'json_schema', schema: DRAFT_SCHEMA } },
      messages: [{ role: 'user', content: draftUser(c) }],
    })
    const j = (r.json ?? {}) as Partial<Draft>
    if (typeof j.subject !== 'string' || typeof j.body !== 'string') throw new Error('draft: not {subject, body}')
    return { draft: { subject: j.subject, body: j.body }, usd: r.usd }
  },

  async extract(a) {
    const r = await haiku(extractRequest(a))
    return { extraction: parseExtraction(r.json), usd: r.usd }
  },
}

export const liveApify: ApifyPort = {
  async startRun(actorId, input, o) {
    const r = await startRun(actorId, input, o)
    return { id: r.id, datasetId: r.datasetId }
  },
  async getRun(runId) {
    const r = await getRun(runId)
    return { status: r.status, datasetId: r.datasetId, usageTotalUsd: r.usageTotalUsd }
  },
  async datasetItems(id) {
    return (await datasetItems(id)).items
  },
}

export const liveDeps: Deps = { store: liveStore, apify: liveApify, ai: liveAi }
