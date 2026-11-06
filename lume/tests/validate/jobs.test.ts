import { describe, expect, it } from 'vitest'
import { jobTitle, jobsPollInterval, partitionJobs, RECENT_MS, showsError, type JobSummary } from '@/lib/validate/jobs'

const NOW = Date.parse('2026-11-05T12:00:00Z')
const job = (o: Partial<JobSummary>): JobSummary => ({
  id: 'j', filename: 'f.csv', status: 'processing', total_rows: 10, processed_rows: 1, enrich: false,
  created_at: '2026-11-05T10:00:00Z', updated_at: '2026-11-05T11:00:00Z', error_message: null, ...o,
})

describe('partitionJobs', () => {
  it('running = pending / processing (any age); recent = finished within 24 h, newest first', () => {
    const jobs = [
      job({ id: 'run', status: 'processing', updated_at: '2026-10-01T00:00:00Z' }),
      job({ id: 'pend', status: 'pending' }),
      job({ id: 'done', status: 'completed', updated_at: '2026-11-05T09:00:00Z' }),
      job({ id: 'fail', status: 'failed', updated_at: '2026-11-05T11:30:00Z', error_message: 'MailTester: Disabled Key' }),
      job({ id: 'old', status: 'completed', updated_at: '2026-11-04T11:59:00Z' }),
    ]
    const { running, recent } = partitionJobs(jobs, NOW)
    expect(running.map((j) => j.id)).toEqual(['run', 'pend'])
    expect(recent.map((j) => j.id)).toEqual(['fail', 'done'])
    expect(RECENT_MS).toBe(24 * 60 * 60 * 1000)
  })
})

describe('jobsPollInterval / showsError', () => {
  it('5 s while anything runs (same cadence as useJobProgress), else 60 s', () => {
    expect(jobsPollInterval({ jobs: [job({ status: 'processing' })] })).toBe(5_000)
    expect(jobsPollInterval({ jobs: [job({ status: 'completed' })] })).toBe(60_000)
    expect(jobsPollInterval(undefined)).toBe(60_000)
  })
  it('failed and cancelled jobs show their error_message; others only when they carry one', () => {
    expect(showsError(job({ status: 'failed', error_message: 'Disabled Key' }))).toBe('Disabled Key')
    expect(showsError(job({ status: 'cancelled', error_message: null }))).toBe('No reason recorded.')
    expect(showsError(job({ status: 'completed', error_message: null }))).toBeNull()
    expect(showsError(job({ status: 'completed', error_message: 'note' }))).toBe('note')
  })
})

describe('jobTitle', () => {
  it('reads "<n> leads · <dd Mon>"', () => {
    expect(jobTitle({ total_rows: 5272, created_at: '2026-11-06T12:00:00Z' })).toBe('5,272 leads · 06 Nov')
  })
})
