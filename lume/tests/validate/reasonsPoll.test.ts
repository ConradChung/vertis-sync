import { describe, expect, it } from 'vitest'
import { reasonsKey, reasonsRefresh } from '@/hooks/useJob'

describe('reason counts polling', () => {
  it('once a minute while the job runs, never otherwise; the key changes when it finishes so it is read once more', () => {
    expect(reasonsRefresh('processing')).toBe(60_000)
    expect(reasonsRefresh('pending')).toBe(60_000)
    expect(reasonsRefresh('completed')).toBe(0)
    expect(reasonsKey('j', 'processing')).toBe('/api/jobs/j/reasons?state=running')
    expect(reasonsKey('j', 'completed')).toBe('/api/jobs/j/reasons?state=done')
  })
})
