import { beforeEach, describe, expect, it } from 'vitest'
import { projectUploadTicket, verifyProjectUploadTicket } from '@/lib/agent/projectTicket'
import { uploadTicket, verifyUploadTicket } from '@/lib/import/ticket'

const PATH = '0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b01/1f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b01.csv'
beforeEach(() => {
  process.env.LUME_INTERNAL_SECRET = 'test-secret'
})

describe('project upload ticket', () => {
  it('verifies its own path, within the TTL', () => {
    const t = projectUploadTicket(PATH, 1000)
    expect(verifyProjectUploadTicket(PATH, t, 2000)).toBe(true)
    expect(verifyProjectUploadTicket(`${PATH}x`, t, 2000)).toBe(false)
    expect(verifyProjectUploadTicket(PATH, t, 1000 + 16 * 60 * 1000)).toBe(false)
  })

  it('is purpose-bound: a CSV import ticket never passes, and vice versa', () => {
    expect(verifyProjectUploadTicket(PATH, uploadTicket(PATH))).toBe(false)
    expect(verifyUploadTicket(PATH, projectUploadTicket(PATH))).toBe(false)
  })
})
