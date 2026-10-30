import { NextResponse } from 'next/server'
import { requireOwnerSession } from '@/lib/auth/guards'
import { newSkillSchema } from '@/lib/agent/skillModel'
import { createSkill, DuplicateSkillNameError, listSkills } from '@/lib/agent/skills'
import { BUILTIN_SKILLS } from '@/lib/agent/builtinSkills'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody } from '@/lib/http/json'

/**
 * Saved agent skills (owner session only).
 *  GET  → `{ skills }`: the built-in skills (`builtin: true`, lib/agent/builtinSkills.ts)
 *         first, then the saved ones, most recently updated first (archived left out).
 *  POST → `{ name, description?, steps, variables?, source_conversation_id? }`;
 *         steps are validated with `newSkillSchema`. 409 on a duplicate name.
 */
export async function GET(req: Request) {
  const auth = await requireOwnerSession(req)
  if (!auth.ok) return auth.response
  try {
    return NextResponse.json({ skills: [...BUILTIN_SKILLS, ...(await listSkills())] })
  } catch (err) {
    return dbErrorResponse(err, 'api/agent/skills')
  }
}

export async function POST(req: Request) {
  const auth = await requireOwnerSession(req)
  if (!auth.ok) return auth.response
  const body = await parseJsonBody(req, newSkillSchema, 64 * 1024)
  if (!body.ok) return body.response
  try {
    return NextResponse.json({ skill: await createSkill(body.data) }, { status: 201 })
  } catch (err) {
    if (err instanceof DuplicateSkillNameError) return NextResponse.json({ error: 'duplicate_name' }, { status: 409 })
    return dbErrorResponse(err, 'api/agent/skills')
  }
}
