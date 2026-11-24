import { describe, expect, it } from 'vitest'
import { buildRedditCard, REDDIT_ACTION_IDS, type RedditMentionRow } from '@/lib/reddit/card'

const row = (over: Partial<RedditMentionRow> = {}): RedditMentionRow => ({
  id: 7,
  url: 'https://www.reddit.com/r/Landlord/comments/1gx3def/best/lyq9xyz/',
  kind: 'comment',
  subreddit: 'Landlord',
  author: 'rental_rita',
  title: 'Best software for a small portfolio?',
  snippet: 'Buildium has been fine for us, support is slow though.',
  keyword: 'buildium',
  hot: false,
  reddit_created_at: '2026-11-23T10:00:00Z',
  alert_status: null,
  decided_by: null,
  ...over,
})
const NOW = new Date('2026-11-23T12:00:00Z')
const json = (c: { blocks: unknown[] }) => JSON.stringify(c.blocks)
type Btn = { action_id: string; url?: string; value?: string }
const buttons = (c: { blocks: Record<string, unknown>[] }) => (c.blocks.find((b) => b.type === 'actions')?.elements ?? []) as Btn[]

describe('buildRedditCard', () => {
  it('shows handle, subreddit, keyword, time, title and snippet', () => {
    const c = buildRedditCard(row(), NOW)
    const s = json(c)
    expect(s).toContain('<https://www.reddit.com/user/rental_rita|u/rental_rita>')
    expect(s).toContain('<https://www.reddit.com/r/Landlord|r/Landlord>')
    expect(s).toContain('`buildium`')
    expect(s).toContain('2h ago')
    expect(s).toContain('Best software for a small portfolio?')
    expect(s).toContain('support is slow')
    expect(c.text).toBe('Reddit r/Landlord: u/rental_rita on buildium')
  })

  it('has Open thread, DM on Reddit, Mark contacted, Skip', () => {
    const b = buttons(buildRedditCard(row(), NOW))
    expect(b.map((x) => x.action_id)).toEqual(['reddit_open', 'reddit_dm', REDDIT_ACTION_IDS.contacted, REDDIT_ACTION_IDS.skip])
    expect(b[0].url).toBe('https://www.reddit.com/r/Landlord/comments/1gx3def/best/lyq9xyz/')
    expect(b[1].url).toBe('https://www.reddit.com/message/compose/?to=rental_rita')
    expect(b[2].value).toBe('7')
  })

  it('🔥 first for hot mentions', () => {
    const c = buildRedditCard(row({ hot: true }), NOW)
    expect(c.text.startsWith('🔥')).toBe(true)
    expect(json(c)).toContain('🔥 *<https://www.reddit.com/user/rental_rita')
  })

  it('no DM button without a usable handle', () => {
    const c = buildRedditCard(row({ author: '[deleted]' }), NOW)
    expect(buttons(c).map((x) => x.action_id)).not.toContain('reddit_dm')
    expect(json(c)).toContain('unknown handle')
  })

  it('escapes third-party text', () => {
    const s = json(buildRedditCard(row({ title: '<!channel> hi', snippet: '<https://evil.example|click> & more' }), NOW))
    expect(s).toContain('&lt;!channel&gt; hi')
    expect(s).toContain('&lt;https://evil.example|click&gt; &amp; more')
    expect(s).not.toContain('<!channel>')
  })

  it('decided cards drop the decision buttons and say who', () => {
    const c = buildRedditCard(row({ alert_status: 'contacted', decided_by: 'U0SALES' }), NOW)
    expect(buttons(c).map((x) => x.action_id)).toEqual(['reddit_open', 'reddit_dm'])
    expect(json(c)).toContain('Contacted · <@U0SALES>')
  })
})

describe('summary line', () => {
  it('shows the escaped summary above the excerpt; none when empty', () => {
    const c = buildRedditCard(row({ summary: 'Hates <Buildium> & wants out' }), NOW)
    const texts = (c.blocks as { text?: { text: string } }[]).map((b) => b.text?.text ?? '')
    const si = texts.findIndex((t) => t.startsWith('💬'))
    expect(texts[si]).toBe('💬 Hates &lt;Buildium&gt; &amp; wants out')
    expect(si).toBeLessThan(texts.findIndex((t) => t.startsWith('>')))
    expect(json(buildRedditCard(row({ summary: null }), NOW))).not.toContain('💬')
  })
})
