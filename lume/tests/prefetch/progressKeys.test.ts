import { describe, expect, it } from 'vitest'
import { TAB_KEYS } from '@/lib/prefetch/tabs'
import { TABS } from '@/components/shell/tabs'

describe('Progress prefetch', () => {
  it('/progress is warmed (its queue and gates); /validate is gone from tabs and prefetch', () => {
    expect(TAB_KEYS['/progress']).toEqual(expect.arrayContaining(['/api/progress', '/api/gates']))
    expect(TAB_KEYS['/validate']).toBeUndefined()
    expect(TABS.map((t) => t.href)).toContain('/progress')
    expect(TABS.map((t) => t.href)).not.toContain('/validate')
  })
})
