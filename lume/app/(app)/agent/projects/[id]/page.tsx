import type { Metadata } from 'next'
import { ProjectView } from '@/components/agent/ProjectView'

export const metadata: Metadata = { title: 'Project' }

/** `/agent/projects/<id>`: one agent project's instructions, files, notes and chats. */
export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <ProjectView id={id} />
}
