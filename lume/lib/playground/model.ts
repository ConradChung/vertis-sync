import { z } from 'zod'
import { diagramSchema, type Diagram } from '@/lib/agent/diagram'
import { UUID_RE } from '@/lib/http/json'

/** Client-safe shapes for saved Playground diagrams. */

export interface SavedDiagram {
  id: string
  title: string
  spec: Diagram
  source_conversation_id: string | null
  created_at: string
  updated_at: string
}

export const newDiagramSchema = z.strictObject({
  title: z.string().trim().min(1).max(120).optional(),
  spec: diagramSchema,
  source_conversation_id: z.string().regex(UUID_RE).nullable().optional(),
  source_message_id: z.string().regex(UUID_RE).nullable().optional(),
})
export type NewDiagram = z.infer<typeof newDiagramSchema>

export const diagramPatchSchema = z.strictObject({ title: z.string().trim().min(1).max(120) })

/** Playground selection, `?d=<kind>:<id>`. */
export type PlaygroundKind = 'saved' | 'campaign' | 'skill'
export interface PlaygroundRef {
  kind: PlaygroundKind
  id: string
}

const REF_RE = /^(saved|campaign|skill):([A-Za-z0-9_-]{1,100})$/

export function parseRef(v: string | null | undefined): PlaygroundRef | null {
  const m = v ? REF_RE.exec(v) : null
  return m ? { kind: m[1] as PlaygroundKind, id: m[2] } : null
}

export const refKey = (r: PlaygroundRef) => `${r.kind}:${r.id}`
