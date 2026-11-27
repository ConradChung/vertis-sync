import { describe, expect, it, vi } from 'vitest'
import * as factsMod from '@/lib/content/facts'
import { generateDraft, runContentTick, MAX_TRIES } from '@/lib/content/engine'
import { FACTS, goodDraft } from './fixtures'
import { deps, good, memoryStore, reply } from './memory'

const TUE_630 = new Date('2026-12-01T14:30:00Z')

// Pin the lead to fact 7 so the fixture draft (built on fact 7) fits.
vi.spyOn(factsMod, 'pickFacts').mockImplementation((_s, _v, facts) => ({
  lead: facts.find((f) => f.id === 7)!,
  supporting: null,
  offer: facts.find((f) => f.id === 1)!,
  background: facts.filter((f) => f.kind === 'quote'),
}))

describe('generateDraft', () => {
  it('dry run (default): stores the accepted draft, never calls Slack', async () => {
    const m = memoryStore({})
    const { d, write, post } = deps(m.store, [reply(good())])
    const r = await generateDraft({ now: TUE_630, slot: 'proof', variant: null, trigger: 'manual' }, d)
    expect(r).toMatchObject({ status: 'accepted', slack: 'dry_run', attempts: 1, usd: 0.1 })
    expect(write).toHaveBeenCalledTimes(1)
    expect(post).not.toHaveBeenCalled()
    expect(m.drafts[0]).toMatchObject({ status: 'accepted', dry_run: true, lead_fact_id: 7, fact_ids: [7, 1], formula: 'F4', char_count: goodDraft().body.length })
    expect(m.spend).toEqual([{ id: 1, usd: 0.1, draft_id: 1 }])
  })

  it('dry_run false: posts to Slack and records the message', async () => {
    const m = memoryStore({ dry_run: false })
    const { d, post } = deps(m.store, [reply(good())])
    const r = await generateDraft({ now: TUE_630, slot: 'proof', variant: null, trigger: 'cron' }, d)
    expect(r.slack).toBe('posted')
    expect(post).toHaveBeenCalledTimes(1)
    const msg = (post.mock.calls[0] as unknown[])[1] as { text: string }
    expect(msg.text).toBe(goodDraft().body)
    expect(m.drafts[0].slack_ts).toBe('1700000000.000100')
  })

  it('rewrites on a rule failure, feeding the failures back', async () => {
    const bad = JSON.stringify(goodDraft({ body: goodDraft().body.replace('another salary', 'another $60k salary') }))
    const m = memoryStore({})
    const { d, write } = deps(m.store, [reply(bad), reply(good())])
    const r = await generateDraft({ now: TUE_630, slot: 'proof', variant: null, trigger: 'manual' }, d)
    expect(r.status).toBe('accepted')
    expect(r.attempts).toBe(2)
    const second = (write.mock.calls[1] as unknown as [{ user: string }])[0].user
    expect(second).toContain('Your previous draft was rejected')
    expect(second).toContain('60k')
  })

  it('after three failures: stored as rejected with the reason, nothing posted', async () => {
    const bad = JSON.stringify(goodDraft({ body: 'too short' }))
    const m = memoryStore({ dry_run: false })
    const { d, write, post } = deps(m.store, [reply(bad), reply(bad), reply(bad)])
    const r = await generateDraft({ now: TUE_630, slot: 'proof', variant: null, trigger: 'manual' }, d)
    expect(write).toHaveBeenCalledTimes(MAX_TRIES)
    expect(r.status).toBe('rejected')
    expect(r.reason).toMatch(/after 3 tries: .*900 to 1300/)
    expect(post).not.toHaveBeenCalled()
    expect(m.drafts[0]).toMatchObject({ status: 'rejected', attempts: 3, usd: 0.3, lead_fact_id: 7 })
  })

  it('unusable replies (refusal, bad JSON) count as tries', async () => {
    const m = memoryStore({})
    const { d } = deps(m.store, [reply(null, 0.01, 'refusal'), reply('not json'), reply(good())])
    const r = await generateDraft({ now: TUE_630, slot: 'proof', variant: null, trigger: 'manual' }, d)
    expect(r).toMatchObject({ status: 'accepted', attempts: 3 })
  })

  it('spend cap: no call at all when the month is at the cap', async () => {
    const m = memoryStore({}, { spent: 4.9 })
    const { d, write } = deps(m.store, [reply(good())])
    const r = await generateDraft({ now: TUE_630, slot: 'proof', variant: null, trigger: 'manual' }, d)
    expect(write).not.toHaveBeenCalled()
    expect(r.status).toBe('rejected')
    expect(r.reason).toMatch(/spend_cap_reached/)
  })

  it('spend cap: stops between tries once the next call could cross it', async () => {
    const bad = JSON.stringify(goodDraft({ body: 'too short' }))
    const m = memoryStore({ monthly_cap_usd: 1 }, { spent: 0.5 })
    const { d, write } = deps(m.store, [reply(bad, 0.3), reply(good())])
    const r = await generateDraft({ now: TUE_630, slot: 'proof', variant: null, trigger: 'manual' }, d)
    expect(write).toHaveBeenCalledTimes(1) // 0.5 + 0.3 = 0.8; 0.8 + 0.25 estimate > 1
    expect(r.reason).toMatch(/spend_cap_reached .*after 1 tries/)
  })

  it('a Claude error stops the run without retrying', async () => {
    const m = memoryStore({})
    const { d, write } = deps(m.store, [])
    const r = await generateDraft({ now: TUE_630, slot: 'proof', variant: null, trigger: 'manual' }, d)
    expect(write).toHaveBeenCalledTimes(1)
    expect(r.reason).toMatch(/claude_error/)
  })

  it('Slack failure keeps the accepted draft and reports the error', async () => {
    const m = memoryStore({ dry_run: false })
    const { d, post } = deps(m.store, [reply(good())])
    post.mockResolvedValueOnce({ error: 'bot_not_in_channel:#content-gen' } as never)
    const r = await generateDraft({ now: TUE_630, slot: 'proof', variant: null, trigger: 'manual' }, d)
    expect(r).toMatchObject({ status: 'accepted', slack: { error: 'bot_not_in_channel:#content-gen' } })
  })
})

describe('runContentTick', () => {
  it('scheduled: writes Tuesday\'s Proof once in the 6 AM PT hour', async () => {
    const m = memoryStore({})
    const { d, write } = deps(m.store, [reply(good()), reply(good())])
    const r = await runContentTick(TUE_630, null, d)
    expect(r).toMatchObject({ ok: true, draft: { slot: 'proof', status: 'accepted' } })
    expect(m.drafts[0].trigger).toBe('cron')
    expect(await runContentTick(TUE_630, null, d)).toMatchObject({ ok: true, skipped: 'already_ran_today' })
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('scheduled: skips outside the window and on non-draft days', async () => {
    const m = memoryStore({})
    const { d, write } = deps(m.store, [])
    expect(await runContentTick(new Date('2026-12-01T13:30:00Z'), null, d)).toMatchObject({ skipped: 'outside_window' })
    expect(await runContentTick(new Date('2026-12-04T14:30:00Z'), null, d)).toMatchObject({ skipped: 'no_slot_today' })
    expect(write).not.toHaveBeenCalled()
  })

  it('manual: runs the given slot on any day; needs a slot on non-draft days', async () => {
    const m = memoryStore({})
    const { d } = deps(m.store, [reply(JSON.stringify(goodDraft({ fact_ids: [7, 1], formula: 'F6', body: goodDraft().body.replace("That's why we built Kaspen. Take a free week on the doors you pick, with setup done for you, and see what your team does with the time back.", "That's why we built Kaspen. Comment week and I'll send the breakdown of how the free week works on the doors you pick.") })))])
    const fri = new Date('2026-12-04T18:00:00Z')
    expect(await runContentTick(fri, { slot: null, variant: null }, d)).toMatchObject({ ok: false, error: 'no_slot_today_pass_slot' })
    const r = await runContentTick(fri, { slot: 'hand_raiser', variant: 'breakdown' }, d)
    expect(r).toMatchObject({ ok: true, draft: { slot: 'hand_raiser', variant: 'breakdown', status: 'accepted' } })
    expect(m.drafts[0].trigger).toBe('manual')
  })

  it('ties a newly seen post to the draft it came from', async () => {
    const posts = [{ post_id: 'urn:li:activity:1', text_excerpt: goodDraft().body.slice(0, 500).replace('hiring faster', 'hiring fast'), posted_at: '2099-01-01T00:00:00Z' }]
    const m = memoryStore({}, { posts })
    const { d } = deps(m.store, [reply(good())])
    await runContentTick(TUE_630, { slot: 'proof', variant: null }, d)
    const r = await runContentTick(new Date('2026-12-04T18:00:00Z'), null, d)
    expect(r.matched).toBe(1)
    expect(m.drafts[0]).toMatchObject({ status: 'posted', posted_post_id: 'urn:li:activity:1' })
  })

  it('uses the real seed facts', () => {
    expect(FACTS).toHaveLength(11)
  })
})
