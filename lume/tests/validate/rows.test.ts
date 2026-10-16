import { describe, expect, it } from 'vitest'
import { mergeRowData, toRowView } from '@/lib/validate/rows'

const raw = (row_data: Record<string, unknown> | null, extra: Record<string, unknown> = {}) => ({
  id: 'r1',
  row_index: 3,
  email: 'a@x.com',
  status: 'pending',
  validation_result: null,
  enrichment_status: null,
  instantly_status: null,
  row_data,
  ...extra,
})

describe('toRowView', () => {
  it('coalesces name keys like lume_lead_bank', () => {
    const v = toRowView(raw({ 'First Name': 'Ann', last_name: 'Lee', Company: 'Acme', icp_status: 'fit' }))
    expect(v).toMatchObject({ first_name: 'Ann', last_name: 'Lee', company_name: 'Acme', icp_status: 'fit' })
    expect(v.name_keys).toEqual({ first_name: 'First Name', last_name: 'last_name', company_name: 'Company' })
  })
  it('prefers the first key with a value; falls back to the present key, then the canonical one', () => {
    const v = toRowView(raw({ 'Company Name': '', company_name: 'B Co' }))
    expect(v.company_name).toBe('B Co')
    expect(v.name_keys.company_name).toBe('company_name')
    const w = toRowView(raw({ first_name: '' }))
    expect(w.first_name).toBeNull()
    expect(w.name_keys.first_name).toBe('first_name')
    expect(w.name_keys.last_name).toBe('Last Name')
  })
  it('reads validation_result.message; null row_data is fine', () => {
    expect(toRowView(raw(null, { validation_result: { message: 'Mailbox full' } })).message).toBe('Mailbox full')
  })
})

describe('mergeRowData', () => {
  it('keeps other keys', () => {
    expect(mergeRowData({ a: 1, b: 'x' }, { b: 'y', c: null })).toEqual({ a: 1, b: 'y', c: null })
    expect(mergeRowData(null, { b: 'y' })).toEqual({ b: 'y' })
  })
})
