import { describe, expect, it } from 'vitest'
import { countScoreboard, type StageChange } from '@/lib/scoreboard/count'
import { weekOf } from '@/lib/scoreboard/week'

const week = weekOf('2026-11-26T20:00:00Z') // Mon Nov 23 – Sun Nov 29, Pacific
const change = (deal_id: string, to: string | null, occurred_at: string): StageChange => ({ deal_id, to, occurred_at })

describe('countScoreboard', () => {
  it('counts deals that entered Conversation and Paid this week, and pilots whose start date is in it', () => {
    const counts = countScoreboard(
      [
        change('a', 'Conversation', '2026-11-23T09:00:00Z'),
        change('b', 'Conversation', '2026-11-25T18:00:00Z'),
        change('c', 'Demo', '2026-11-25T18:00:00Z'),
        change('d', 'Paid', '2026-11-27T01:00:00Z'),
      ],
      [
        { id: 'p1', pilot_start_date: '2026-11-23' },
        { id: 'p2', pilot_start_date: '2026-11-29' },
      ],
      week
    )
    expect(counts).toEqual({ conversations: 2, pilots_started: 2, pilots_paid: 1 })
  })

  it('a deal moved in and out of a stage counts once', () => {
    const counts = countScoreboard(
      [
        change('a', 'Conversation', '2026-11-23T10:00:00Z'),
        change('a', 'Replied', '2026-11-24T10:00:00Z'),
        change('a', 'Conversation', '2026-11-25T10:00:00Z'),
        change('p', 'Paid', '2026-11-25T10:00:00Z'),
        change('p', 'Pilot', '2026-11-25T11:00:00Z'),
        change('p', 'Paid', '2026-11-26T10:00:00Z'),
      ],
      [{ id: 'x', pilot_start_date: '2026-11-24' }, { id: 'x', pilot_start_date: '2026-11-24' }],
      week
    )
    expect(counts).toEqual({ conversations: 1, pilots_started: 1, pilots_paid: 1 })
  })

  it('the week runs Monday 00:00 to the next Monday 00:00 Pacific: the edges', () => {
    const counts = countScoreboard(
      [
        change('before', 'Conversation', '2026-11-23T07:59:59Z'), // Sunday 23:59:59 PT
        change('first', 'Conversation', '2026-11-23T08:00:00Z'), // Monday 00:00 PT
        change('last', 'Conversation', '2026-11-30T07:59:59Z'), // Sunday 23:59:59 PT
        change('after', 'Conversation', '2026-11-30T08:00:00Z'), // next Monday
      ],
      [
        { id: 'sun-before', pilot_start_date: '2026-11-22' },
        { id: 'mon', pilot_start_date: '2026-11-23' },
        { id: 'next-mon', pilot_start_date: '2026-11-30' },
      ],
      week
    )
    expect(counts).toEqual({ conversations: 2, pilots_started: 1, pilots_paid: 0 })
  })

  it('other stages, rows without a target and unreadable times count for nothing; an empty week is zeros', () => {
    expect(
      countScoreboard(
        [change('a', 'Pilot', '2026-11-25T10:00:00Z'), change('b', null, '2026-11-25T10:00:00Z'), change('c', 'Paid', 'not a date'), change('d', 'conversation', '2026-11-25T10:00:00Z')],
        [{ id: 'n', pilot_start_date: null }],
        week
      )
    ).toEqual({ conversations: 0, pilots_started: 0, pilots_paid: 0 })
    expect(countScoreboard([], [], week)).toEqual({ conversations: 0, pilots_started: 0, pilots_paid: 0 })
  })
})
