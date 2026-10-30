import { beforeEach, describe, expect, it, vi } from 'vitest'

/** sweepFileUploads + claimFileUpload against a tiny fake of the service client. */

const db = vi.hoisted(() => ({
  uploads: [] as { storage_path: string; created_at: string; claimed_at: string | null }[],
  files: [] as { id: string }[],
  removed: [] as string[][],
  removeError: null as null | { message: string },
}))

vi.mock('@/lib/supabase/service', () => {
  function query(table: string) {
    const filters: ((r: Record<string, unknown>) => boolean)[] = []
    let op: 'select' | 'update' | 'delete' = 'select'
    let patch: Record<string, unknown> = {}
    const rows = () => (table === 'agent_chat_file_uploads' ? db.uploads : db.files) as unknown as Record<string, unknown>[]
    const run = () => {
      const hit = rows().filter((r) => filters.every((f) => f(r)))
      if (op === 'update') hit.forEach((r) => Object.assign(r, patch))
      if (op === 'delete') db.uploads = db.uploads.filter((r) => !hit.includes(r as never))
      return { data: hit, error: null }
    }
    const q = {
      select: () => q,
      update: (p: Record<string, unknown>) => ((op = 'update'), (patch = p), q),
      delete: () => ((op = 'delete'), q),
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), q),
      is: (k: string, v: unknown) => (filters.push((r) => r[k] === v), q),
      in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), q),
      lt: (k: string, v: string) => (filters.push((r) => String(r[k]) < v), q),
      order: () => q,
      limit: () => q,
      maybeSingle: async () => ({ data: run().data[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown) => Promise.resolve(run()).then(ok),
    }
    return q
  }
  return {
    createServiceClient: () => ({
      from: query,
      storage: { from: () => ({ remove: async (paths: string[]) => (db.removed.push(paths), { error: db.removeError }) }) },
    }),
  }
})

import { claimFileUpload, sweepFileUploads } from '@/lib/agent/chatFiles'

const A = '0f3c2b1a-9d8e-4f7a-8b6c-00000000000a'
const B = '0f3c2b1a-9d8e-4f7a-8b6c-00000000000b'
const old = '2026-10-30T00:00:00.000Z'

beforeEach(() => {
  db.uploads = [
    { storage_path: `${A}.xlsx`, created_at: old, claimed_at: null },
    { storage_path: `${B}.csv`, created_at: old, claimed_at: old },
  ]
  db.files = [{ id: B }]
  db.removed = []
  db.removeError = null
})

describe('sweepFileUploads', () => {
  it('deletes the source and parsed objects of never-finalized uploads; a finalized one only loses its leftover row', async () => {
    expect(await sweepFileUploads(new Date('2026-10-30T05:00:00Z'))).toEqual({ ok: true, removed: 1, kept: 1 })
    expect(db.removed).toEqual([[`${A}.xlsx`, `${A}.json.gz`]])
    expect(db.uploads).toEqual([])
  })
  it('a failed Storage delete keeps the orphan row for the next run', async () => {
    db.removeError = { message: 'nope' }
    expect(await sweepFileUploads(new Date('2026-10-30T05:00:00Z'))).toMatchObject({ ok: false })
    expect(db.uploads.map((u) => u.storage_path)).toEqual([`${A}.xlsx`])
  })
  it('nothing older than the cutoff: nothing happens', async () => {
    expect(await sweepFileUploads(new Date('2026-10-29T00:00:00Z'))).toEqual({ ok: true, removed: 0, kept: 0 })
    expect(db.removed).toEqual([])
  })
})

describe('claimFileUpload', () => {
  it('claims once; a second claim is taken; an unknown path is missing', async () => {
    expect(await claimFileUpload(`${A}.xlsx`)).toBe('claimed')
    expect(await claimFileUpload(`${A}.xlsx`)).toBe('taken')
    expect(await claimFileUpload('nope.csv')).toBe('missing')
  })
})
