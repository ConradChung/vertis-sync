import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { addMemory, listMemories } from '@/lib/agent/memory'
import { newMemorySchema } from '@/lib/agent/memoryModel'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody } from '@/lib/http/json'

/**
 * The agent's saved memories (owner session, or the agent's bearer for the
 * remember tool).
 *  GET  → `{ memories }` newest first.
 *  POST `{ kind, content, conversation_id? }` → `{ memory, duplicate }`.
 */
const Body = newMemorySchema.extend({ conversation_id: z.string().uuid().nullable().optional() })

export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  try {
    return NextResponse.json({ memories: await listMemories() })
  } catch (err) {
    return dbErrorResponse(err, 'api/agent/memory')
  }
}

export async function POST(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const body = await parseJsonBody(req, Body, 4096)
  if (!body.ok) return body.response
  try {
    const r = await addMemory(body.data.kind, body.data.content, body.data.conversation_id ?? null)
    return NextResponse.json(r, { status: r.duplicate ? 200 : 201 })
  } catch (err) {
    return dbErrorResponse(err, 'api/agent/memory')
  }
}
