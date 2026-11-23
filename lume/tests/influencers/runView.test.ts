import { describe, expect, it } from 'vitest'
import {
  apifyDatasetUrl,
  apifyRunUrl,
  costLines,
  countLines,
  isLiveRunAction,
  isRunLive,
  runIdFromAction,
  stageList,
  stageStates,
} from '@/lib/influencers/runView'

const RUN = '7d4d1955-108b-4b87-bb3a-939e6f41aeb8'

describe('runIdFromAction', () => {
  it('influencer_reactions: payload.run_id', () => {
    expect(runIdFromAction({ kind: 'influencer_reactions', status: 'executed', payload: { run_id: RUN }, result: null })).toBe(RUN)
  })
  it('influencer_run: result.run_id once executed', () => {
    expect(runIdFromAction({ kind: 'influencer_run', status: 'executed', payload: { slugs: ['x'] }, result: { run_id: RUN, status: 'running' } })).toBe(RUN)
    expect(runIdFromAction({ kind: 'influencer_run', status: 'approved', payload: {}, result: null })).toBeNull()
  })
  it('null while awaiting, rejected, or for other kinds', () => {
    expect(runIdFromAction({ kind: 'influencer_reactions', status: 'awaiting', payload: { run_id: RUN }, result: null })).toBeNull()
    expect(runIdFromAction({ kind: 'influencer_reactions', status: 'rejected', payload: { run_id: RUN }, result: null })).toBeNull()
    expect(runIdFromAction({ kind: 'run_actor', status: 'executed', payload: {}, result: { run_id: 'abc' } })).toBeNull()
  })
  it('isLiveRunAction covers approved / executing / executed / failed', () => {
    for (const status of ['approved', 'executing', 'executed', 'failed']) expect(isLiveRunAction({ kind: 'influencer_run', status })).toBe(true)
    expect(isLiveRunAction({ kind: 'influencer_run', status: 'awaiting' })).toBe(false)
  })
})

describe('stages', () => {
  it('a targeted run skips posts and top_posts', () => {
    expect(stageList({ counts: { targeted_posts: 1 } })).toEqual(['reactions', 'triage', 'verify', 'doors', 'output'])
    expect(stageList({ counts: { posts: 12 } })[0]).toBe('posts')
    expect(stageList({ counts: null })).toHaveLength(7)
  })
  it('before the current stage done, current active, after todo', () => {
    const s = stageStates({ status: 'running', stage: 'triage', counts: { reactions: 57, targeted_posts: 1 } })
    expect(s.map((x) => x.state)).toEqual(['done', 'active', 'todo', 'todo', 'todo'])
    expect(s[1].label).toBe('Triage')
  })
  it('awaiting the bill = needs_you; failed run marks the stage failed; done is all done', () => {
    expect(stageStates({ status: 'awaiting_approval', stage: 'reactions', counts: {} })[2].state).toBe('needs_you')
    expect(stageStates({ status: 'failed', stage: 'verify', counts: {} })[4].state).toBe('failed')
    expect(stageStates({ status: 'done', stage: 'output', counts: {} }).every((x) => x.state === 'done')).toBe(true)
  })
  it('polls only while running or awaiting approval', () => {
    expect(isRunLive('running')).toBe(true)
    expect(isRunLive('awaiting_approval')).toBe(true)
    for (const s of ['done', 'failed', 'cancelled']) expect(isRunLive(s)).toBe(false)
  })
})

describe('links and lines', () => {
  it('Apify console links', () => {
    expect(apifyRunUrl('DAacaf6Y5jfKjfAm7')).toBe('https://console.apify.com/actors/runs/DAacaf6Y5jfKjfAm7')
    expect(apifyDatasetUrl('V3v1OQSLOoB7RJ49g')).toBe('https://console.apify.com/storage/datasets/V3v1OQSLOoB7RJ49g')
  })
  it('counts in pipeline order, present keys only; final new_reactors supersedes the merged tally', () => {
    expect(countLines({ reactions: 57, targeted_posts: 1, new_reactors_merged: 14, transient_streak: 0 }).map((c) => [c.key, c.value])).toEqual([
      ['reactions', 57],
      ['new_reactors_merged', 14],
    ])
    expect(countLines({ new_reactors: 20, new_reactors_merged: 14, verified: 3, leads_700: 1 }).map((c) => c.key)).toEqual(['new_reactors', 'verified', 'leads_700'])
    expect(countLines(null)).toEqual([])
  })
  it('cost: every numeric key as $, total last', () => {
    expect(costLines({ total: 0.5, apify_reactions: 0.1, perplexity: '0.4', note: 'x' })).toEqual([
      { key: 'apify_reactions', label: 'apify reactions', value: '$0.10' },
      { key: 'perplexity', label: 'perplexity', value: '$0.40' },
      { key: 'total', label: 'total', value: '$0.50' },
    ])
  })
})
