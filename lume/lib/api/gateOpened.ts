import { z } from 'zod'
import { GATE_KINDS, GATE_TARGET_TABLES } from '@/lib/db/types'

/**
 * Body of the `lume_gate_opened()` trigger's POST to /api/hooks/gate-opened:
 * `jsonb_build_object('kind', kind, 'target_table', tg_table_name, 'target_id', n->>'id')`.
 * Pure (no server-only) so the schema is unit-tested.
 *
 * Loose 8-4-4-4-12 hex rather than a versioned UUID check: pipeline ids are
 * gen_random_uuid(), and the smoke check sends the nil uuid.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const gateOpenedSchema = z.object({
  kind: z.enum(GATE_KINDS),
  target_table: z.enum(GATE_TARGET_TABLES),
  target_id: z.string().regex(UUID_RE, 'target_id must be a uuid'),
})

export type GateOpenedBody = z.infer<typeof gateOpenedSchema>
