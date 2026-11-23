import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FRANK_FACTS, parseSignalConfig } from '@/lib/signal/config'
import {
  buildSignalCard,
  buildSignalDigest,
  buildSignalEditModal,
  FOOTER,
  REACTOR_OPENING_PLACEHOLDER,
  renderCardAsText,
  SIGNAL_ACTION_IDS,
  SLACK_BLOCK_LIMIT,
} from '@/lib/slack/signalCard'
import { person } from './fixtures'

const NOW = new Date('2026-11-23T12:00:00Z')
const opts = (over: Partial<{ premium: boolean; connectionsLoaded: boolean }> = {}) => ({ premium: false, noteLimit: 200, connectionsLoaded: true, now: NOW, post: { post_url: 'https://www.linkedin.com/feed/update/urn:li:activity:7400' }, ...over })
const all = (blocks: unknown) => JSON.stringify(blocks)

describe('buildSignalCard', () => {
  it('renders header, doors, location, no contacts section, the escaped comment with links and relative time, buttons and footer', () => {
    const { blocks, text } = buildSignalCard(person(), opts())
    const s = all(blocks)
    expect(text).toContain('Ada Lovelace (Acme Property Mgmt)')
    expect(s).toContain('<https://www.linkedin.com/in/ada-pm|Ada Lovelace>')
    expect(s).toContain('<https://acmepm.com|Acme Property Mgmt>')
    expect(s).toContain('~1,200 (high confidence · <https://acmepm.com/about|source>)')
    expect(s).toContain('Vancouver, BC')
    expect(s).toContain("PM commented on Frank's post")
    expect(s).not.toContain('Bob Owner') // Apollo contacts are never shown
    expect(s).not.toContain('Contacts')
    expect(s).not.toContain('owner-operator')
    expect(s).toContain('&lt;@channel&gt; &amp; so true')
    expect(s).not.toContain('<@channel>')
    expect(s).toContain('|comment>')
    expect(s).toContain('|post>')
    expect(s).toContain('3h ago')
    const actions = blocks.find((b) => b.type === 'actions') as { elements: { action_id: string; value: string }[] }
    expect(actions.elements.map((e) => e.action_id)).toEqual([SIGNAL_ACTION_IDS.approve, SIGNAL_ACTION_IDS.edit, SIGNAL_ACTION_IDS.skip])
    expect(actions.elements.every((e) => e.value === '42')).toBe(true)
    expect(s).toContain(FOOTER)
    expect(blocks.length).toBeLessThanOrEqual(SLACK_BLOCK_LIMIT)
  })

  it('doors unknown when there is no count', () => {
    expect(all(buildSignalCard(person({ door_count: null }), opts()).blocks)).toContain('*Doors:* unknown')
  })

  it('connected null: DM, note, after they accept, after they reply, each in a code block; no no-note version', () => {
    const s = all(buildSignalCard(person(), opts({ premium: true, noteLimit: 300 } as never)).blocks)
    expect(s).toContain("*If you're connected → DM*\\n```Hi Ada, thanks for the comment.```")
    expect(s).toContain('*If not connected → connection note (36/300 chars)*\\n```Hi Ada, saw your comment on my post.```')
    expect(s).toContain('*After they accept*\\n```Thanks for connecting!```')
    expect(s).toContain("*After they reply (either way) → Kaspen + demo*\\n```I'm also a co-founder of Kaspen. Would you like to see a quick demo?```")
    expect(s).not.toContain('No-note')
    expect(s.indexOf('→ DM')).toBeLessThan(s.indexOf('After they reply'))
  })

  it('owner-operator: labelled in the header, fallback and a note line', () => {
    const r = person({ segment: 'owner_operator', crawl_verdict: 'owner_operator' })
    const { blocks, text } = buildSignalCard(r, opts())
    const s = all(blocks)
    expect(s).toContain("Owner-operator commented on Frank's post")
    expect(s).toContain('owner-operator')
    expect(text).toContain('Owner-operator commented')
    // An owner-operator verdict on a PM row is refused.
    expect(() => buildSignalCard(person({ crawl_verdict: 'owner_operator' }), opts())).toThrow(/refused/)
  })

  it('connected true: only the DM', () => {
    const s = all(buildSignalCard(person({ connected: true }), opts()).blocks)
    expect(s).toContain('DM*')
    expect(s).not.toContain('connection note')
    expect(s).not.toContain('After they accept')
    expect(s).toContain('After they reply')
  })

  it('connected false: note + follow-up (+ no-note when not premium), no DM', () => {
    const s = all(buildSignalCard(person({ connected: false }), opts()).blocks)
    expect(s).not.toContain('→ DM')
    expect(s).toContain('Not connected → connection note (36/200 chars)')
    expect(s).toContain('After they accept')
    expect(s).toContain('After they reply')
  })

  it('treats connected as unknown until Connections.csv is loaded', () => {
    const s = all(buildSignalCard(person({ connected: true }), opts({ connectionsLoaded: false })).blocks)
    expect(s).toContain("If you're connected → DM")
    expect(s).toContain('If not connected → connection note')
  })

  it('a ``` inside a draft cannot close the code block; a long note is flagged', () => {
    const s = all(buildSignalCard(person({ drafts: { dm: 'a ```b``` c', connection_note: 'x'.repeat(250) } }), opts()).blocks)
    expect(s).toContain('```a ʼʼʼbʼʼʼ c```')
    expect(s).toContain('(250/200 chars) ⚠️ over the limit')
  })

  it('refuses a vendor or any non-PM row', () => {
    expect(() => buildSignalCard(person({ crawl_verdict: 'vendor' }), opts())).toThrow(/not property_manager/)
    expect(() => buildSignalCard(person({ crawl_verdict: null }), opts())).toThrow(/not property_manager/)
  })

  it('approved: drafts still visible, no buttons; skipped: collapsed', () => {
    const a = buildSignalCard(person({ alert_status: 'approved', decided_by: 'U0SALES' }), opts()).blocks
    expect(all(a)).toContain('Approved by <@U0SALES>')
    expect(all(a)).toContain('```Hi Ada, thanks for the comment.```')
    expect(a.find((b) => b.type === 'actions')).toBeUndefined()
    const sk = buildSignalCard(person({ alert_status: 'skipped', decided_by: 'U0SALES' }), opts()).blocks
    expect(sk.length).toBe(2)
    expect(all(sk)).toContain('Skipped by <@U0SALES>')
    expect(all(sk)).not.toContain('```')
    const ed = buildSignalCard(person({ alert_status: 'edited', decided_by: 'U0SALES' }), opts()).blocks
    expect(all(ed)).toContain('edited by <@U0SALES>')
    expect(ed.find((b) => b.type === 'actions')).toBeDefined()
  })

  it('never links a non-http URL', () => {
    const s = all(buildSignalCard(person({ linkedin_url: 'javascript:alert(1)', company_website: 'acme.com' }), opts()).blocks)
    expect(s).not.toContain('javascript:')
    expect(s).toContain('<https://acme.com|Acme Property Mgmt>')
  })
})

describe('buildSignalDigest', () => {
  const post = { post_id: '7400', post_url: 'https://www.linkedin.com/feed/update/urn:li:activity:7400', posted_at: '2026-11-20T12:00:00Z', text_excerpt: 'Rent day is chaos' }
  const reactors = (n: number) => Array.from({ length: n }, (_, i) => person({ id: 100 + i, kind: 'reactor', name: `Reactor ${i}`, comment_text: null }))

  it('shows the excerpt, link, the opening placeholder while reactor_opening is null, and each PM reactor', () => {
    const d = buildSignalDigest(post, reactors(2), { ...opts(), reactorOpening: null })
    const s = all(d.blocks)
    expect(s).toContain('Rent day is chaos')
    expect(s).toContain('|Open the post>')
    expect(s).toContain(REACTOR_OPENING_PLACEHOLDER)
    expect(s).toContain('Reactor 0')
    expect(s).toContain('Reactor 1')
    expect(s).toContain(FOOTER)
    expect(d.shown).toEqual([100, 101])
  })

  it('uses reactor_opening when set', () => {
    const s = all(buildSignalDigest(post, reactors(1), { ...opts(), reactorOpening: 'Saw you liked my post' }).blocks)
    expect(s).toContain('```Saw you liked my post```')
    expect(s).not.toContain(REACTOR_OPENING_PLACEHOLDER)
  })

  it('caps at 8 people, then "+N more", and stays under 50 blocks even with long drafts', () => {
    const long = { dm: 'd'.repeat(2500), connection_note: 'n'.repeat(190), followup_dm: 'f'.repeat(2500), after_reply: 'x'.repeat(2500) }
    for (const rs of [reactors(20), reactors(20).map((r) => ({ ...r, drafts: long }))]) {
      const d = buildSignalDigest(post, rs, { ...opts(), reactorOpening: null })
      expect(d.blocks.length).toBeLessThanOrEqual(SLACK_BLOCK_LIMIT)
      expect(d.shown.length).toBeLessThanOrEqual(8)
      expect(all(d.blocks)).toContain(`+${20 - d.shown.length} more PM reactors`)
    }
    expect(buildSignalDigest(post, reactors(20), { ...opts(), reactorOpening: null }).shown.length).toBe(8)
  })

  it('leaves out non-PM reactors', () => {
    const d = buildSignalDigest(post, [person({ id: 1, kind: 'reactor', crawl_verdict: 'vendor' }), person({ id: 2, kind: 'reactor' })], { ...opts(), reactorOpening: null })
    expect(d.shown).toEqual([2])
  })
})

describe('edit modal and text preview', () => {
  it('has a multiline input per draft field, prefilled, with the person id', () => {
    const m = buildSignalEditModal(person(), 200) as { callback_id: string; private_metadata: string; blocks: { block_id: string; element: { multiline: boolean; initial_value?: string; max_length: number } }[] }
    expect(m.callback_id).toBe('signal_edit')
    expect(m.private_metadata).toBe('42')
    expect(m.blocks.map((b) => b.block_id)).toEqual(['signal_dm', 'signal_connection_note', 'signal_followup_dm', 'signal_after_reply'])
    expect(m.blocks.every((b) => b.element.multiline)).toBe(true)
    expect(m.blocks[0].element.initial_value).toBe('Hi Ada, thanks for the comment.')
    expect(m.blocks[1].element.max_length).toBe(200)
  })

  it('renderCardAsText turns blocks into readable text', () => {
    const t = renderCardAsText(buildSignalCard(person(), opts()).blocks)
    expect(t).toContain("# 💬 PM commented on Frank's post")
    expect(t).toContain('Ada Lovelace (https://www.linkedin.com/in/ada-pm)')
    expect(t).toContain('<@channel> & so true')
    expect(t).toContain('[Approve] [Edit] [Skip]')
    expect(renderCardAsText(null)).toBe('')
  })
})

describe('config and facts', () => {
  it('FRANK_FACTS mirrors frank-facts.json', () => {
    const json = JSON.parse(readFileSync(new URL('../../../supabase/functions/_shared/signal/frank-facts.json', import.meta.url), 'utf8'))
    expect(FRANK_FACTS).toEqual({ linkedin_premium: json.linkedin_premium, connection_note_max_chars: json.connection_note_max_chars, connections_csv_loaded: json.connections_csv_loaded })
  })
  it('anything but dry_run:false is a dry run; slack ids are validated', () => {
    expect(parseSignalConfig(null).dry_run).toBe(true)
    expect(parseSignalConfig({ dry_run: 'false' }).dry_run).toBe(true)
    expect(parseSignalConfig({ dry_run: false }).dry_run).toBe(false)
    expect(parseSignalConfig({ slack: { team_id: 'T082MHH6U5P', channel_id: 'bad', channel_name: '#sales' } }).slack).toEqual({ team_id: 'T082MHH6U5P', channel_id: null, channel_name: 'sales' })
  })
})
