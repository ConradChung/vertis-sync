import { describe, expect, it } from 'vitest'
import { groupQueues } from '@/lib/rotation/queues'

const KAS = { id: 'v-kas', name: 'Kaspen / Zenport', campaign_ids: ['old', 'kaspen', 'kaspen-nl'] }

describe('groupQueues', () => {
  it('groups campaigns under their tag with their place in line (oldest queued first)', () => {
    const tags = groupQueues(
      [
        { campaign_id: 'kaspen', queued: 3747, active: 0, finished: 0, oldest_queued_at: '2026-11-09T21:58:00Z', last_pushed_at: null },
        { campaign_id: 'old', queued: 992, active: 995, finished: 225, oldest_queued_at: '2026-10-09T00:00:00Z', last_pushed_at: '2026-11-01T00:00:00Z' },
        { campaign_id: 'kaspen-nl', queued: 813, active: 0, finished: 0, oldest_queued_at: '2026-11-09T21:58:01Z', last_pushed_at: null },
        { campaign_id: 'stray', queued: 0, active: 5, finished: 0, oldest_queued_at: null, last_pushed_at: null },
      ],
      new Map([['old', { name: 'Scaleport - Fall Mega', status: 'paused' }], ['kaspen', { name: 'Kaspen', status: 'draft' }]]),
      [KAS]
    )
    expect(tags.map((t) => t.tag)).toEqual(['Kaspen / Zenport', 'Untagged'])
    expect(tags[0].campaigns.map((c) => [c.name, c.place])).toEqual([
      ['Scaleport - Fall Mega', 1],
      ['Kaspen', 2],
      ['Campaign kaspen-n', 3],
    ])
    expect(tags[0].queued).toBe(3747 + 992 + 813)
    expect(tags[1].campaigns[0].place).toBeNull()
  })
})
