// Run: deno test instantly-rotate/
import { assertEquals } from 'jsr:@std/assert@1'
import { allocate, freeSlots, rotationCampaigns } from './allocate.ts'

const A = '869d73b3-5bf3-4f1c-ba8c-43ac6d0f529d'
const B = 'bbbbbbbb-0000-0000-0000-000000000000'
const C = 'cccccccc-0000-0000-0000-000000000000'
const q = (id: number, campaign_id: string) => ({ id, campaign_id })

Deno.test('freeSlots: cap minus what the workspace holds, bounded by the per-run max, never negative', () => {
  assertEquals(freeSlots(1000, 995, 450), 5)
  assertEquals(freeSlots(1000, 100, 450), 450)
  assertEquals(freeSlots(1000, 1000, 450), 0)
  assertEquals(freeSlots(1000, 1012, 450), 0)
})

Deno.test('allocate: one campaign behaves as before (lowest ids first, up to the free slots)', () => {
  const r = allocate({ cap: 1000, inWorkspace: 997, maxPush: 450, queued: [q(5, A), q(3, A), q(9, A), q(4, A)] })
  assertEquals(r.free, 3)
  assertEquals(r.picked.map((x) => x.id), [3, 4, 5])
  assertEquals(r.perCampaign, { [A]: 3 })
})

Deno.test('allocate: the cap is shared and the oldest queue goes first across campaigns', () => {
  const queued = [q(10, B), q(2, A), q(11, B), q(3, A), q(1, C), q(12, A)]
  const r = allocate({ cap: 1000, inWorkspace: 996, maxPush: 450, queued })
  assertEquals(r.picked.map((x) => [x.id, x.campaign_id]), [[1, C], [2, A], [3, A], [10, B]])
  assertEquals(r.perCampaign, { [C]: 1, [A]: 2, [B]: 1 })
})

Deno.test('allocate: the per-run max bounds the total across campaigns', () => {
  const queued = Array.from({ length: 600 }, (_, i) => q(i + 1, i % 2 ? A : B))
  const r = allocate({ cap: 1000, inWorkspace: 0, maxPush: 450, queued })
  assertEquals(r.free, 450)
  assertEquals(r.picked.length, 450)
  assertEquals(r.perCampaign[A] + r.perCampaign[B], 450)
  assertEquals(r.picked.at(-1)?.id, 450)
})

Deno.test('allocate: nothing when the workspace is full (or over)', () => {
  for (const inWorkspace of [1000, 1003]) {
    const r = allocate({ cap: 1000, inWorkspace, maxPush: 450, queued: [q(1, A), q(2, B)] })
    assertEquals([r.free, r.picked.length, r.perCampaign], [0, 0, {}])
  }
})

Deno.test('allocate: excluded (tripped) campaigns give their slots to the next oldest', () => {
  const r = allocate({ cap: 1000, inWorkspace: 998, maxPush: 450, queued: [q(1, B), q(2, B), q(3, A), q(4, A)], exclude: new Set([B]) })
  assertEquals(r.picked.map((x) => x.id), [3, 4])
})

Deno.test('rotationCampaigns: ROTATE_CAMPAIGN_ID always first, no duplicates', () => {
  assertEquals(rotationCampaigns(A, []), [A])
  assertEquals(rotationCampaigns(A, [B, A, C, B, '']), [A, B, C])
})
