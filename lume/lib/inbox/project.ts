import 'server-only'
import { projectForVertical } from '@/lib/agent/projects'
import { InboxError, type InboxScope } from '@/lib/inbox/scope'

/**
 * The project an inbox bot reads and writes its SOP files in (voice-rules.md,
 * qualify-rules.md, …): the project linked to the vertical. A vertical bot
 * always gets its own vertical's; the owner, the master bot and the agent
 * name one with `vertical_id`. 404 when the vertical has no linked project.
 */
export async function inboxProject(scope: InboxScope, verticalParam: string | null): Promise<{ id: string; name: string }> {
  const verticalId = scope.all ? verticalParam : scope.verticalId
  if (!verticalId) throw new InboxError(400, scope.all ? 'vertical_id_required' : 'no_vertical')
  if (!scope.all && verticalParam && verticalParam !== scope.verticalId) throw new InboxError(403, 'vertical_out_of_scope')
  const project = await projectForVertical(verticalId)
  if (!project) throw new InboxError(404, 'no_project_for_vertical')
  return project
}
