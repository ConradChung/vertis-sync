import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingActionRow } from '@/lib/db/types'

// No DB, Telegram or Apify network: the store, service and adapter are mocked.
const store = vi.hoisted(() => ({
  claimExecution: vi.fn(),
  finishAction: vi.fn(),
  getAction: vi.fn(),
  getStaleApprovedIds: vi.fn(),
  failInterruptedActions: vi.fn(),
  insertQueuedLeads: vi.fn(),
  resolveLeadsByRefs: vi.fn(),
  resolveLeadsByFilter: vi.fn(),
  getRule: vi.fn(),
  activateRule: vi.fn(),
  deleteRule: vi.fn(),
}))
vi.mock('@/lib/actions/store', () => store)
const svc = vi.hoisted(() => ({
  logEvent: vi.fn(),
  getPushJob: vi.fn(),
  findAwaitingAction: vi.fn(),
  findAwaitingRuleAction: vi.fn(),
  insertPendingAction: vi.fn(),
  setActionMessageId: vi.fn(),
  getCampaignByExternalId: vi.fn(),
  getInstantlyEmailEvent: vi.fn(),
}))
vi.mock('@/lib/db/service', () => ({ ...svc, PUSH_REVIEW_STATUSES: [], isDbError: (e: unknown) => e instanceof Error && 'code' in e }))
const camp = vi.hoisted(() => ({ findAwaitingActionBy: vi.fn() }))
vi.mock('@/lib/campaigns/service', () => camp)
vi.mock('@/lib/adapters/telegram', () => ({ sendMessage: vi.fn(), sendActionPrompt: vi.fn().mockResolvedValue({ ok: false }) }))
vi.mock('@/lib/adapters/pipeline', () => ({ decide: vi.fn() }))
vi.mock('@/lib/adapters/instantlyPush', () => ({ getPushPreview: vi.fn() }))

const apify = vi.hoisted(() => ({
  getActor: vi.fn(),
  getActorInputSchema: vi.fn(),
  planTier: vi.fn(),
  startRun: vi.fn(),
  searchStore: vi.fn(),
}))
vi.mock('@/lib/adapters/apify', async (orig) => ({ ...(await orig<typeof import('@/lib/adapters/apify')>()), ...apify }))

import { buildActionRequest } from '@/lib/actions/build'
import { createAction, DuplicateActionError } from '@/lib/actions/create'
import { executeAction } from '@/lib/actions/execute'

const ID = '0a4c1e2f-5b6d-4e7f-8a9b-0c1d2e3f4a5b'
const PPE = {
  pricingModel: 'PAY_PER_EVENT',
  startedAt: '2025-01-01T00:00:00Z',
  minimalMaxTotalChargeUsd: 0.5,
  pricingPerEvent: {
    actorChargeEvents: {
      'actor-start': { eventTitle: 'Actor start', eventPriceUsd: 0.007 },
      'place-scraped': { eventTitle: 'Place scraped', eventPriceUsd: 0.004, isPrimaryEvent: true },
    },
  },
}
const SCHEMA = {
  properties: {
    searchStringsArray: { type: 'array', title: 'Search' },
    locationQuery: { type: 'string', title: 'Location' },
    maxCrawledPlacesPerSearch: { type: 'integer', minimum: 1 },
  },
  required: ['searchStringsArray', 'locationQuery'],
}
const INPUT = { searchStringsArray: ['roofers'], locationQuery: 'Austin, TX', maxCrawledPlacesPerSearch: 500 }

function actor(pricingInfos: unknown[] = [PPE]) {
  return { id: 'A1', name: 'compass/crawler-google-places', title: 'Google Maps Scraper', description: '', pricingInfos, defaultMemoryMb: 4096, isDeprecated: false }
}

beforeEach(() => {
  vi.clearAllMocks()
  apify.getActor.mockResolvedValue(actor())
  apify.getActorInputSchema.mockResolvedValue({ schema: SCHEMA, minMemoryMb: null, maxMemoryMb: null })
  apify.planTier.mockResolvedValue('BRONZE')
  apify.startRun.mockResolvedValue({ id: 'RUN12345', status: 'READY', datasetId: 'DS1', consoleUrl: 'https://console.apify.com/x' })
  store.finishAction.mockResolvedValue(undefined)
  camp.findAwaitingActionBy.mockResolvedValue(null)
})

async function built(payload: Record<string, unknown>) {
  const b = await buildActionRequest({ kind: 'run_actor', payload })
  if (!b.ok) throw new Error(`build failed: ${b.error}`)
  return b.payload
}

function row(payload: Record<string, unknown>): PendingActionRow {
  return {
    id: ID, kind: 'run_actor', payload: payload as PendingActionRow['payload'], risk: 'high', status: 'executing', claim_status: 'claimed',
    requested_by: 'agent', agent_run_id: null, rule_id: null, telegram_message_id: null, decided_via: 'lume', decided_at: null,
    executed_at: null, result: null, error: null, created_at: '', updated_at: '',
  }
}

describe('run_actor: build (what the owner confirms)', () => {
  it('validates the input and snapshots capped options, estimate, cap and a readable summary', async () => {
    const p = await built({ actor_id: 'compass~crawler-google-places', input: INPUT, expected_items: 500 })
    expect(p).toMatchObject({
      actor_id: 'compass/crawler-google-places',
      pricing_model: 'PAY_PER_EVENT',
      input: INPUT,
      options: { maxTotalChargeUsd: 20, timeout: 3600 },
      budget_usd: 20,
      cap_usd: 20,
      estimate_usd: 2.01,
      expected_items: 500,
    })
    expect(p.input_hash).toMatch(/^[0-9a-f]{32}$/)
    expect(p.summary).toContain('Google Maps Scraper')
    expect(p.summary).toContain('hard cap $20.00')
    expect(p.summary).toContain('locationQuery: Austin, TX')
  })

  it('refuses inputs that do not validate against the actor schema', async () => {
    const b = await buildActionRequest({ kind: 'run_actor', payload: { actor_id: 'compass/crawler-google-places', input: { searchStringsArray: ['x'], invented: 1 } } })
    expect(b).toMatchObject({ ok: false, status: 400, error: expect.stringContaining('locationQuery is required') })
    expect(b.ok === false && b.error).toContain('invented is not an input of this actor')
  })

  it('refuses an actor whose cost cannot be capped, and a budget above $20', async () => {
    apify.getActor.mockResolvedValue(actor([{ pricingModel: 'FLAT_PRICE_PER_MONTH', pricePerUnitUsd: 30 }]))
    expect(await buildActionRequest({ kind: 'run_actor', payload: { actor_id: 'a/b', input: INPUT } })).toMatchObject({ ok: false, status: 409 })
    expect(await buildActionRequest({ kind: 'run_actor', payload: { actor_id: 'a/b', input: INPUT, max_charge_usd: 25 } })).toMatchObject({
      ok: false,
      status: 400,
    })
  })

  it('one awaiting action per identical request', async () => {
    const p = await built({ actor_id: 'compass/crawler-google-places', input: INPUT })
    camp.findAwaitingActionBy.mockResolvedValue({ id: 'existing' })
    await expect(createAction('run_actor', p, 'agent')).rejects.toBeInstanceOf(DuplicateActionError)
    expect(camp.findAwaitingActionBy).toHaveBeenCalledWith('run_actor', 'input_hash', p.input_hash)
    expect(svc.insertPendingAction).not.toHaveBeenCalled()
  })

  it('createAction refuses a snapshot whose options exceed the cap', async () => {
    const p = await built({ actor_id: 'compass/crawler-google-places', input: INPUT })
    await expect(createAction('run_actor', { ...p, options: { timeout: 60, maxTotalChargeUsd: 50 } }, 'agent')).rejects.toThrow(/exceed the cap/)
  })
})

describe('run_actor: execute (after the tap)', () => {
  it('starts the run with the confirmed limits; a double tap is a no-op', async () => {
    const p = await built({ actor_id: 'compass/crawler-google-places', input: INPUT, max_charge_usd: 8 })
    store.claimExecution.mockResolvedValueOnce(row(p)).mockResolvedValueOnce(null)
    store.getAction.mockResolvedValue({ ...row(p), status: 'executed' })

    const first = await executeAction(ID)
    expect(first).toMatchObject({ ran: true, status: 'executed', result: { run_id: 'RUN12345', dataset_id: 'DS1' } })
    expect(apify.startRun).toHaveBeenCalledWith('compass/crawler-google-places', INPUT, { timeout: 3600, maxTotalChargeUsd: 8 })

    const second = await executeAction(ID)
    expect(second).toEqual({ ran: false, reason: 'not_claimable', status: 'executed' })
    expect(apify.startRun).toHaveBeenCalledTimes(1)
  })

  it('fails without starting when the pricing changed to something uncappable', async () => {
    const p = await built({ actor_id: 'compass/crawler-google-places', input: INPUT })
    apify.getActor.mockResolvedValue(actor([{ pricingModel: 'FLAT_PRICE_PER_MONTH', pricePerUnitUsd: 30 }]))
    store.claimExecution.mockResolvedValueOnce(row(p))
    const out = await executeAction(ID)
    expect(out).toMatchObject({ ran: true, status: 'failed', error: expect.stringContaining('re-check failed') })
    expect(apify.startRun).not.toHaveBeenCalled()
  })

  it('never starts with options above the cap, even if the stored payload was tampered with', async () => {
    const p = await built({ actor_id: 'compass/crawler-google-places', input: INPUT })
    store.claimExecution.mockResolvedValueOnce(row({ ...p, options: { timeout: 3600, maxTotalChargeUsd: 500 } }))
    const out = await executeAction(ID)
    expect(out).toMatchObject({ ran: true, status: 'failed', error: 'confirmed budget exceeds the cap' })
    expect(apify.startRun).not.toHaveBeenCalled()
  })

  it('pay per result: a price rise since confirmation shrinks maxItems, never grows it', async () => {
    apify.getActor.mockResolvedValue(actor([{ pricingModel: 'PRICE_PER_DATASET_ITEM', pricePerUnitUsd: 0.002 }]))
    const p = await built({ actor_id: 'compass/crawler-google-places', input: INPUT })
    expect(p.options).toMatchObject({ maxItems: 10_000 })
    apify.getActor.mockResolvedValue(actor([{ pricingModel: 'PRICE_PER_DATASET_ITEM', pricePerUnitUsd: 0.004 }]))
    store.claimExecution.mockResolvedValueOnce(row(p))
    await executeAction(ID)
    expect(apify.startRun.mock.calls[0][2]).toMatchObject({ maxItems: 5000, maxTotalChargeUsd: 20 })
  })
})
