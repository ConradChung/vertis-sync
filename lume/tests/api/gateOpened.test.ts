import { describe, expect, it } from 'vitest'
import { gateOpenedSchema } from '@/lib/api/gateOpened'
import { GATE_KINDS } from '@/lib/db/types'

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e'

describe('gateOpenedSchema', () => {
  it('accepts the trigger payload for every gate kind', () => {
    expect(GATE_KINDS).toHaveLength(11)
    for (const kind of GATE_KINDS) {
      const r = gateOpenedSchema.safeParse({ kind, target_table: 'validation_jobs', target_id: ID })
      expect(r.success, kind).toBe(true)
    }
  })

  it('accepts the nil uuid used by the smoke check', () => {
    const r = gateOpenedSchema.safeParse({
      kind: 'ingest_approval',
      target_table: 'telegram_ingests',
      target_id: '00000000-0000-0000-0000-000000000000',
    })
    expect(r.success).toBe(true)
  })

  it('rejects an unknown kind', () => {
    const r = gateOpenedSchema.safeParse({ kind: 'bogus', target_table: 'validation_jobs', target_id: ID })
    expect(r.success).toBe(false)
  })

  it('rejects unknown tables, non-uuid ids and missing fields', () => {
    expect(gateOpenedSchema.safeParse({ kind: 'stall', target_table: 'users', target_id: ID }).success).toBe(false)
    expect(gateOpenedSchema.safeParse({ kind: 'stall', target_table: 'validation_jobs', target_id: '42' }).success).toBe(false)
    expect(gateOpenedSchema.safeParse({ kind: 'stall', target_table: 'validation_jobs' }).success).toBe(false)
    expect(gateOpenedSchema.safeParse(null).success).toBe(false)
  })
})
