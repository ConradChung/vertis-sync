import { describe, expect, it } from 'vitest'
import { actionTag, conversationTag, followParent, jobBatchTag, leadListTag, taskTag, validationJobTag } from '@/lib/tags/rules'

const keys = { jobs: 'JOBS', hnwi: 'HNWI', pm_reactions: 'PM' }

describe('auto-tag rules (mirror of 20261109092501_lume_tags.sql)', () => {
  it('job batches are always job search unless already tagged', () => {
    expect(jobBatchTag(null, keys)).toBe('JOBS')
    expect(jobBatchTag('KAS', keys)).toBe('KAS')
  })

  it('validation jobs: ingest, then HNWI source, then the campaign owner', () => {
    expect(validationJobTag({ ingest: 'KAS', source: 'hnwi' }, keys)).toBe('KAS')
    expect(validationJobTag({ source: 'hnwi', campaign: 'KAS' }, keys)).toBe('HNWI')
    expect(validationJobTag({ source: 'csv', campaign: 'KAS' }, keys)).toBe('KAS')
    expect(validationJobTag({ source: 'csv', campaignNoLocation: 'KAS' }, keys)).toBe('KAS')
    expect(validationJobTag({ source: 'csv' }, keys)).toBeNull()
  })

  it("lead lists: project, then influencer sheet → PM reactions, then the chat that made it", () => {
    expect(leadListTag({ project: 'KAS', sheetKind: 'influencer_candidates' }, keys)).toBe('KAS')
    expect(leadListTag({ sheetKind: 'influencer_candidates', conversation: 'KAS' }, keys)).toBe('PM')
    expect(leadListTag({ sheetKind: 'leads', conversation: 'KAS' }, keys)).toBe('KAS')
    expect(leadListTag({}, keys)).toBeNull()
  })

  it('actions: the item they name before the chat they came from', () => {
    expect(actionTag({ target: 'JOBS', conversation: 'KAS' })).toBe('JOBS')
    expect(actionTag({ list: 'KAS', campaign: 'HNWI' })).toBe('KAS')
    expect(actionTag({ campaign: 'KAS', conversation: 'JOBS' })).toBe('KAS')
    expect(actionTag({ conversation: 'KAS' })).toBe('KAS')
    expect(actionTag({})).toBeNull()
  })

  it("tasks and chats", () => {
    expect(taskTag({ conversation: 'KAS', action: 'JOBS' })).toBe('KAS')
    expect(taskTag({ action: 'JOBS' })).toBe('JOBS')
    expect(conversationTag({ project: 'KAS' })).toBe('KAS')
    expect(conversationTag({ own: 'JOBS', project: 'KAS' })).toBe('JOBS')
  })

  it('carry-down: an inherited or empty tag follows the parent; an explicit one stays', () => {
    expect(followParent(null, 'KAS', 'PM')).toBe('PM')
    expect(followParent('KAS', 'KAS', 'PM')).toBe('PM')
    expect(followParent('JOBS', 'KAS', 'PM')).toBe('JOBS')
    expect(followParent('KAS', 'KAS', null)).toBeNull()
  })
})
