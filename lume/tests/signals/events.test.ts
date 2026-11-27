import { describe, expect, it } from 'vitest'
import { hiringEvent, personEvent, reactorEvent, redditEvent, type HiringSource, type PersonSource, type ReactorSource, type RedditSource } from '@/lib/signals/events'
import { mergeSignals } from '@/lib/signals/merge'

const hiring = (o: Partial<HiringSource> = {}): HiringSource => ({
  id: 1,
  signal: 'hiring',
  role_title: 'Regional Property Manager',
  headline: null,
  source_url: 'https://jobs.example/1',
  posted_at: '2026-11-20T00:00:00Z',
  company_name: 'Acme PM',
  company_domain: 'acme.com',
  company_website: 'https://www.acme.com',
  company_phone: '(310) 555-0101',
  person_name: null,
  person_title: null,
  person_linkedin: null,
  stage: 'done',
  skip_reason: null,
  status: 'new',
  created_at: '2026-11-21T00:00:00Z',
  ...o,
})
const person = (o: Partial<PersonSource> = {}): PersonSource => ({
  id: 9,
  kind: 'commenter',
  stage: 'alerted',
  skip_reason: null,
  name: 'Ada Lovelace',
  title: 'COO',
  linkedin_url: 'https://linkedin.com/in/ada',
  company_name: 'Acme Property Management',
  company_website: 'https://acme.com',
  post_id: 'p1',
  comment_text: '  We struggle with\nafter-hours calls ',
  comment_url: null,
  commented_at: '2026-11-25T00:00:00Z',
  created_at: '2026-11-25T01:00:00Z',
  ...o,
})
const reddit = (o: Partial<RedditSource> = {}): RedditSource => ({
  id: 4,
  url: 'https://reddit.com/r/x/1',
  permalink: '/r/x/1',
  subreddit: 'PropertyManagement',
  author: 'pm_dave',
  title: 'Answering service?',
  summary: null,
  snippet: 'long text',
  alert_status: 'posted',
  reddit_created_at: '2026-11-24T00:00:00Z',
  created_at: '2026-11-24T02:00:00Z',
  ...o,
})
const reactor = (o: Partial<ReactorSource> = {}): ReactorSource => ({
  id: 44,
  name: 'Bob Stone',
  title: 'Owner',
  linkedin_url: 'https://linkedin.com/in/bob',
  company_name: 'Stone Rentals',
  company_website: 'stonerentals.com',
  reacted_to: ['peter-lohmann', 'frank22', 'jordan-muela'],
  door_count: 1200,
  verdict: 'verified',
  verified_at: '2026-11-10T00:00:00Z',
  updated_at: '2026-11-11T00:00:00Z',
  ...o,
})

describe('hiringEvent', () => {
  it('maps a finished, kept row', () => {
    expect(hiringEvent(hiring())).toEqual({
      source: 'hiring',
      ref: 'hiring:1',
      company: 'Acme PM',
      site: 'acme.com',
      at: '2026-11-20T00:00:00Z',
      label: 'Hiring: Regional Property Manager',
      url: 'https://jobs.example/1',
      phone: '(310) 555-0101',
      person: null,
      person_title: null,
      linkedin: null,
      detail: { source: 'hiring', signal: 'Hiring', role: 'Regional Property Manager' },
    })
    expect(hiringEvent(hiring({ signal: 'new_manager', role_title: null, headline: 'Jane joins as VP Ops', posted_at: null, company_domain: null }))).toMatchObject({
      label: 'New manager: Jane joins as VP Ops',
      at: '2026-11-21T00:00:00Z',
      site: 'https://www.acme.com',
    })
  })
  it('leaves out rows still in the pipeline, rows the pipeline skipped and rows the owner skipped', () => {
    expect(hiringEvent(hiring({ stage: 'pending' }))).toBeNull()
    expect(hiringEvent(hiring({ skip_reason: 'not_pm' }))).toBeNull()
    expect(hiringEvent(hiring({ status: 'skipped' }))).toBeNull()
    expect(hiringEvent(hiring({ status: 'sent' }))).not.toBeNull()
  })
})

describe('personEvent', () => {
  const posts = new Map([['p1', { post_id: 'p1', post_url: 'https://linkedin.com/posts/frank-1', text_excerpt: 'x' }]])
  it('maps a commenter, quoting the comment on one line and linking the post when the comment has no link', () => {
    expect(personEvent(person(), posts)).toMatchObject({
      source: 'comment',
      ref: 'comment:9',
      company: 'Acme Property Management',
      site: 'https://acme.com',
      at: '2026-11-25T00:00:00Z',
      label: 'Commented: “We struggle with after-hours calls”',
      url: 'https://linkedin.com/posts/frank-1',
      person: 'Ada Lovelace',
      person_title: 'COO',
    })
    expect(personEvent(person({ comment_url: 'https://linkedin.com/c/1' }), posts)?.url).toBe('https://linkedin.com/c/1')
    expect(personEvent(person({ kind: 'reactor', comment_text: null }), posts)?.label).toBe('Reacted to a watched post')
    expect(personEvent(person({ comment_text: null, post_id: 'gone' }), posts)).toMatchObject({ label: 'Commented on a watched post', url: null })
  })
  it('carries the comment and its post for the Post comments columns', () => {
    expect(personEvent(person(), posts)?.detail).toEqual({
      source: 'comment',
      reaction: false,
      comment: 'We struggle with after-hours calls',
      post_url: 'https://linkedin.com/posts/frank-1',
      post_excerpt: 'x',
    })
    expect(personEvent(person({ kind: 'reactor', comment_text: null, post_id: 'gone' }), posts)?.detail).toEqual({
      source: 'comment',
      reaction: true,
      comment: null,
      post_url: null,
      post_excerpt: null,
    })
  })
  it('clips a long comment', () => {
    const label = personEvent(person({ comment_text: 'word '.repeat(80) }), posts)!.label
    expect(label.length).toBeLessThan(160)
    expect(label.endsWith('…”')).toBe(true)
  })
  it('leaves out people the filter skipped or that errored', () => {
    expect(personEvent(person({ skip_reason: 'vendor' }), posts)).toBeNull()
    expect(personEvent(person({ stage: 'skipped' }), posts)).toBeNull()
    expect(personEvent(person({ stage: 'error' }), posts)).toBeNull()
  })
})

describe('redditEvent', () => {
  it('maps a mention: the author is the account, there is no company', () => {
    expect(redditEvent(reddit())).toMatchObject({
      source: 'reddit',
      ref: 'reddit:4',
      company: null,
      site: null,
      handle: 'pm_dave',
      label: 'r/PropertyManagement: Answering service?',
      url: 'https://reddit.com/r/x/1',
      at: '2026-11-24T00:00:00Z',
    })
    expect(redditEvent(reddit({ summary: 'Asks who handles after-hours calls', subreddit: 'r/Landlord' }))?.label).toBe('r/Landlord: Asks who handles after-hours calls')
  })
  it('carries subreddit, thread title and excerpt for the Reddit columns', () => {
    expect(redditEvent(reddit({ subreddit: 'r/Landlord', summary: 'Asks who handles after-hours calls' }))?.detail).toEqual({
      source: 'reddit',
      subreddit: 'Landlord',
      thread: 'Answering service?',
      excerpt: 'long text',
      author: 'pm_dave',
    })
    expect(redditEvent(reddit({ snippet: null, summary: 'Asks who handles after-hours calls' }))?.detail).toMatchObject({ excerpt: 'Asks who handles after-hours calls' })
  })
  it('leaves out skipped mentions and ones with no author', () => {
    expect(redditEvent(reddit({ alert_status: 'skipped' }))).toBeNull()
    expect(redditEvent(reddit({ author: ' ' }))).toBeNull()
    expect(redditEvent(reddit({ author: null }))).toBeNull()
  })
})

describe('reactorEvent', () => {
  it('maps a verified reactor with who they reacted to and the door count', () => {
    expect(reactorEvent(reactor())).toMatchObject({
      source: 'influencer',
      ref: 'influencer:44',
      company: 'Stone Rentals',
      site: 'stonerentals.com',
      at: '2026-11-10T00:00:00Z',
      label: 'Reacted to Peter Lohmann, Frank +1 · 1,200 doors',
      person: 'Bob Stone',
      person_title: 'Owner',
    })
    expect(reactorEvent(reactor({ reacted_to: [], door_count: null, verified_at: null }))).toMatchObject({ label: 'Reacted to an influencer', at: '2026-11-11T00:00:00Z' })
  })
  it('only verified reactors are signals', () => {
    for (const verdict of ['rejected', null, 'pending']) expect(reactorEvent(reactor({ verdict }))).toBeNull()
  })
})

describe('across sources', () => {
  it('a hiring row, a commenter and a reactor of one company become one account', () => {
    const posts = new Map<string, never>()
    const events = [hiringEvent(hiring()), personEvent(person(), posts), reactorEvent(reactor({ company_name: 'ACME PM', company_website: 'http://www.acme.com/team' })), redditEvent(reddit())].filter(
      (e) => e !== null
    )
    const rows = mergeSignals(events)
    expect(rows.map((r) => [r.key, r.sources, r.count])).toEqual([
      ['d:acme.com', ['hiring', 'comment', 'influencer'], 3],
      ['r:pm_dave', ['reddit'], 1],
    ])
    expect(rows[0].phone).toBe('(310) 555-0101')
  })
})
