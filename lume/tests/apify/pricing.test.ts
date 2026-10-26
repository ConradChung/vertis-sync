import { describe, expect, it } from 'vitest'
import { ACTOR_RUN_CAP_USD, currentPricingInfo, describePrice, parsePricing, planRun } from '@/lib/apify/pricing'

const PPE = {
  pricingModel: 'PAY_PER_EVENT',
  minimalMaxTotalChargeUsd: 0.5,
  pricingPerEvent: {
    actorChargeEvents: {
      'actor-start': { eventTitle: 'Actor start', eventPriceUsd: 0.007 },
      'place-scraped': { eventTitle: 'Place scraped', eventPriceUsd: 0.004, isPrimaryEvent: true },
      'filter-applied': { eventTitle: 'Add-on: Filter applied', eventPriceUsd: 0.001 },
    },
  },
}
const TIERED = {
  pricingModel: 'PAY_PER_EVENT',
  pricingPerEvent: {
    actorChargeEvents: {
      'review-scraped': {
        eventTitle: 'Scraped review',
        isPrimaryEvent: true,
        eventTieredPricingUsd: { FREE: { tieredEventPriceUsd: 0.0006 }, BRONZE: { tieredEventPriceUsd: 0.00045 } },
      },
    },
  },
}
const PPR = { pricingModel: 'PRICE_PER_DATASET_ITEM', pricePerUnitUsd: 0.002 }

describe('parsePricing', () => {
  it('reads events, the primary one and one-time start fees', () => {
    const p = parsePricing(PPE)
    expect(p.model).toBe('PAY_PER_EVENT')
    expect(p.events.find((e) => e.name === 'actor-start')?.oneTime).toBe(true)
    expect(p.events.find((e) => e.primary)?.priceUsd).toBe(0.004)
    expect(p.minimalMaxTotalChargeUsd).toBe(0.5)
  })
  it('uses the plan tier price, else the priciest tier', () => {
    expect(parsePricing(TIERED, 'BRONZE').events[0].priceUsd).toBe(0.00045)
    expect(parsePricing(TIERED, null).events[0].priceUsd).toBe(0.0006)
    expect(parsePricing(TIERED, 'DIAMOND').events[0].priceUsd).toBe(0.0006)
  })
  it('picks the latest pricing that has started', () => {
    const infos = [
      { pricingModel: 'FREE', startedAt: '2024-01-01T00:00:00Z' },
      { pricingModel: 'PAY_PER_EVENT', startedAt: '2025-01-01T00:00:00Z' },
      { pricingModel: 'PRICE_PER_DATASET_ITEM', startedAt: '2099-01-01T00:00:00Z' },
    ]
    expect((currentPricingInfo(infos, new Date('2026-10-01')) as { pricingModel: string }).pricingModel).toBe('PAY_PER_EVENT')
  })
  it('describes prices for a shortlist', () => {
    expect(describePrice(parsePricing(PPE))).toContain('$0.004 per place scraped')
    expect(describePrice(parsePricing(PPR))).toBe('$2 per 1,000 results')
  })
})

describe('planRun — the $20 cap', () => {
  it('pay per event: maxTotalChargeUsd = budget, estimate from expected items', () => {
    const plan = planRun(parsePricing(PPE), { expectedItems: 1000 })
    expect(plan).toMatchObject({ ok: true, budgetUsd: 20, options: { maxTotalChargeUsd: 20, timeout: 3600 } })
    if (plan.ok) expect(plan.estimateUsd).toBeCloseTo(4.01, 2)
  })
  it('pay per event: estimate is clipped to the budget and says where the cap stops it', () => {
    const plan = planRun(parsePricing(PPE), { expectedItems: 100_000, maxChargeUsd: 10 })
    expect(plan.ok && plan.estimateUsd).toBe(10)
    expect(plan.ok && plan.options.maxTotalChargeUsd).toBe(10)
    expect(plan.ok && plan.estimateNote).toMatch(/cap stops it at about 2498 results/)
  })
  it('pay per event: refused when the actor needs a bigger minimum budget', () => {
    const plan = planRun(parsePricing({ ...PPE, minimalMaxTotalChargeUsd: 25 }))
    expect(plan).toMatchObject({ ok: false })
  })
  it('pay per result: maxItems = floor(budget / price)', () => {
    const plan = planRun(parsePricing(PPR), { expectedItems: 50_000 })
    expect(plan).toMatchObject({ ok: true, options: { maxItems: 10_000, maxTotalChargeUsd: 20 } })
    expect(plan.ok && plan.estimateUsd).toBe(20)
    expect(plan.ok && plan.estimateNote).toMatch(/capped at 10000 results/)
  })
  it('pay per result: a result pricier than the budget is refused', () => {
    expect(planRun(parsePricing({ pricingModel: 'PRICE_PER_DATASET_ITEM', pricePerUnitUsd: 30 })).ok).toBe(false)
  })
  it('pay per usage: memory and timeout keep worst-case compute inside the budget', () => {
    const plan = planRun(parsePricing({ pricingModel: 'FREE' }), { defaultMemoryMb: 8192 })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.options.memory).toBe(4096)
    expect((plan.options.memory! / 1024) * (plan.options.timeout / 3600) * 0.4).toBeLessThanOrEqual(plan.budgetUsd)
    const tiny = planRun(parsePricing({ pricingModel: 'FREE' }), { defaultMemoryMb: 4096, maxChargeUsd: 0.5 })
    expect(tiny.ok && (tiny.options.memory! / 1024) * (tiny.options.timeout / 3600) * 0.4).toBeLessThanOrEqual(0.5)
  })
  it('rental and unknown models are refused (cost cannot be bounded)', () => {
    expect(planRun(parsePricing({ pricingModel: 'FLAT_PRICE_PER_MONTH', pricePerUnitUsd: 30 }))).toMatchObject({ ok: false })
    expect(planRun(parsePricing({ pricingModel: 'SOMETHING_NEW' }))).toMatchObject({ ok: false })
    expect(planRun(parsePricing({ pricingModel: 'PAY_PER_EVENT', pricingPerEvent: { actorChargeEvents: {} } })).ok).toBe(false)
  })
  it('a budget above the cap is refused, never silently raised', () => {
    expect(planRun(parsePricing(PPE), { maxChargeUsd: 25 })).toMatchObject({ ok: false, reason: expect.stringContaining('$20 cap') })
    expect(ACTOR_RUN_CAP_USD).toBe(20)
  })
  it('timeouts are bounded', () => {
    expect(planRun(parsePricing(PPE), { timeoutSecs: 10 ** 7 }).ok && planRun(parsePricing(PPE), { timeoutSecs: 10 ** 7 })).toMatchObject({
      options: { timeout: 7200 },
    })
  })
})
