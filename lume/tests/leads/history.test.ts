import { describe, expect, it } from 'vitest'
import { summarizeArchived } from '@/lib/leads/history'

describe('summarizeArchived (lead_bank rows no longer in Instantly)', () => {
  it('counts replied, bounced and finished-no-reply like the CRM backfill', () => {
    expect(
      summarizeArchived([
        { state: 'skipped', final_status: 1, email_reply_count: 1 }, // replied, then deleted (orphaned)
        { state: 'skipped', final_status: 3, email_reply_count: 1 },
        { state: 'bounced', final_status: -1, email_reply_count: 0 },
        { state: 'skipped', final_status: -1, email_reply_count: null },
        { state: 'completed', final_status: 3, email_reply_count: 0 },
        { state: 'skipped', final_status: 3, email_reply_count: null },
        { state: 'unsubscribed', final_status: -2, email_reply_count: 0 },
      ])
    ).toEqual({ total: 7, replied: 2, bounced: 2, finished_no_reply: 2 })
  })
})
