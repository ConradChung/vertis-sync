'use client'

import { useEffect } from 'react'

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')

/**
 * Files dropped outside a drop target would make the browser open them and
 * leave Lume. While mounted, a file drag that no target handled (none called
 * preventDefault) is cancelled at the window, with a "not allowed" cursor.
 * React's own handlers run first (they live on the root), so real drop
 * targets are unaffected.
 */
export function useFileDropGuard(): void {
  useEffect(() => {
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e) || e.defaultPrevented) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
    }
    const onDrop = (e: DragEvent) => {
      if (hasFiles(e) && !e.defaultPrevented) e.preventDefault()
    }
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [])
}
