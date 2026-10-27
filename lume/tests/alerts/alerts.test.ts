import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => {
  const state = { error: null as { message: string } | null, throws: false, calls: [] as { op: string; row: unknown; opts?: unknown }[] }
  const from = vi.fn((table: string) => {
    if (state.throws) throw new Error('client exploded')
    return {
      insert: (row: unknown) => {
        state.calls.push({ op: `insert:${table}`, row })
        return Promise.resolve({ error: state.error })
      },
      upsert: (row: unknown, opts: unknown) => {
        state.calls.push({ op: `upsert:${table}`, row, opts })
        return Promise.resolve({ error: state.error })
      },
    }
  })
  return { state, from }
})
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ from: db.from }) }))

import { alert, alertLink, parseChannels, telegramSkipped, titleFrom } from '@/lib/alerts'

beforeEach(() => {
  db.state.error = null
  db.state.throws = false
  db.state.calls = []
  delete process.env.ALERT_CHANNELS
  delete process.env.LUME_URL
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('parseChannels', () => {
  it('missing or empty → telegram + feed', () => {
    expect([...parseChannels(undefined)].sort()).toEqual(['feed', 'telegram'])
    expect([...parseChannels('')].sort()).toEqual(['feed', 'telegram'])
    expect([...parseChannels('  ')].sort()).toEqual(['feed', 'telegram'])
  })
  it('a comma list, case and spaces tolerated', () => {
    expect([...parseChannels('feed')]).toEqual(['feed'])
    expect([...parseChannels(' Telegram , FEED ')].sort()).toEqual(['feed', 'telegram'])
  })
  it('unknown tokens are ignored with a warning', () => {
    const warn = vi.fn()
    expect([...parseChannels('feed,grok', warn)]).toEqual(['feed'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('grok'))
  })
  it('nothing recognised → the default, so a typo never silences Telegram', () => {
    const warn = vi.fn()
    expect([...parseChannels('bogus', warn)].sort()).toEqual(['feed', 'telegram'])
  })
})

describe('titleFrom / alertLink', () => {
  it('first non-empty line, markdown stripped, capped at 200', () => {
    expect(titleFrom('\n*Done* — `x`\nmore')).toBe('Done — x')
    expect(titleFrom('✅ Done — push_to_instantly')).toBe('✅ Done — push_to_instantly')
    expect(titleFrom('_italic_ and **bold**')).toBe('italic and bold')
    expect(titleFrom('a'.repeat(300))).toHaveLength(200)
  })
  it('absolute with LUME_URL, relative without', () => {
    expect(alertLink('/actions/1')).toBe('/actions/1')
    process.env.LUME_URL = 'https://lume.example/'
    expect(alertLink('/actions/1')).toBe('https://lume.example/actions/1')
  })
})

describe('alert', () => {
  it('default: inserts the feed row and runs the telegram callback, passing its result through', async () => {
    const telegram = vi.fn().mockResolvedValue({ ok: true, messageId: 9 })
    const out = await alert({ source: 'lume.test', title: 'T', body: 'B', link: '/x', campaign_id: 'c1', scope: 'campaign', telegram })
    expect(telegram).toHaveBeenCalledTimes(1)
    expect(out).toEqual({ ok: true, messageId: 9 })
    expect(db.state.calls).toEqual([
      {
        op: 'insert:lume_alerts',
        row: { source: 'lume.test', severity: 'info', title: 'T', body: 'B', link: '/x', campaign_id: 'c1', scope: 'campaign', dedupe_key: null },
      },
    ])
  })

  it('ALERT_CHANNELS=feed: telegram skipped, feed still written, undefined returned', async () => {
    process.env.ALERT_CHANNELS = 'feed'
    const telegram = vi.fn()
    expect(await alert({ source: 's', title: 'T', telegram })).toBeUndefined()
    expect(telegram).not.toHaveBeenCalled()
    expect(db.state.calls).toHaveLength(1)
  })

  it('dedupe_key → upsert on dedupe_key ignoring duplicates', async () => {
    await alert({ source: 's', title: 'Gate', severity: 'urgent', dedupe_key: 'a1:lume_action' })
    expect(db.state.calls[0]).toMatchObject({
      op: 'upsert:lume_alerts',
      row: { dedupe_key: 'a1:lume_action', severity: 'urgent' },
      opts: { onConflict: 'dedupe_key', ignoreDuplicates: true },
    })
  })

  it('a feed error (returned or thrown) is logged and swallowed; telegram still runs', async () => {
    db.state.error = { message: 'boom' }
    expect(await alert({ source: 's', title: 'T', telegram: async () => 1 })).toBe(1)
    db.state.error = null
    db.state.throws = true
    expect(await alert({ source: 's', title: 'T', telegram: async () => 2 })).toBe(2)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('lume_alerts'), expect.anything())
  })

  it('a telegram error propagates as before, after the feed insert was attempted', async () => {
    await expect(alert({ source: 's', title: 'T', telegram: async () => { throw new Error('tg') } })).rejects.toThrow('tg')
    expect(db.state.calls).toHaveLength(1)
  })

  it('telegram is called before the feed insert settles (no added send latency)', async () => {
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    db.from.mockImplementationOnce(() => ({
      insert: async () => { order.push('feed:start'); await gate; order.push('feed:end'); return { error: null } },
      upsert: async () => ({ error: null }),
    }))
    const p = alert({ source: 's', title: 'T', telegram: async () => { order.push('telegram'); release(); return 1 } })
    expect(await p).toBe(1)
    expect(order).toEqual(['feed:start', 'telegram', 'feed:end'])
  })

  it('telegramSkipped is the adapter-shaped "not sent" result for feed-only mode', () => {
    expect(telegramSkipped).toEqual({ ok: false, skipped: true })
  })
})
