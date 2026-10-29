'use client'

import { useCallback, useEffect, useState } from 'react'
import type { ProjectSummary } from '@/lib/agent/projectModel'

export interface ProjectList {
  /** null until the first load. */
  items: ProjectSummary[] | null
  setItems: React.Dispatch<React.SetStateAction<ProjectSummary[] | null>>
  reload: () => Promise<void>
}

/** Agent projects in sidebar order, refetched whenever `refreshKey` changes. */
export function useProjectList(refreshKey = 0): ProjectList {
  const [items, setItems] = useState<ProjectSummary[] | null>(null)
  const reload = useCallback(async () => {
    try {
      const res = await fetch('/api/agent/projects', { credentials: 'same-origin' })
      if (!res.ok) throw new Error(String(res.status))
      const body = (await res.json()) as { projects?: ProjectSummary[] }
      setItems(Array.isArray(body.projects) ? body.projects : [])
    } catch {
      setItems((v) => v ?? [])
    }
  }, [])
  useEffect(() => {
    void reload()
  }, [reload, refreshKey])
  return { items, setItems, reload }
}
