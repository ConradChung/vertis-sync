'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Maximize2, Minimize2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * A sheet's table is a fixed-height preview, so its scrollbars (horizontal
 * included) stay in view; Expand fills the screen, Escape or Collapse returns.
 */
export function useSheetExpand() {
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setExpanded(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded])
  return { expanded, toggle: () => setExpanded((x) => !x) }
}

export function ExpandButton({ expanded, onClick }: { expanded: boolean; onClick: () => void }) {
  const Icon = expanded ? Minimize2 : Maximize2
  return (
    <Button variant="outline" size="sm" onClick={onClick} aria-pressed={expanded}>
      <Icon className="size-3.5" /> {expanded ? 'Collapse' : 'Expand'}
    </Button>
  )
}

/** Renders in place, or full-screen on `document.body` while expanded (the card's backdrop blur would trap a fixed overlay). */
export function SheetOverlay({ expanded, children }: { expanded: boolean; children: ReactNode }) {
  if (!expanded) return children
  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">{children}</div>,
    document.body,
  )
}

/** One scroll box for both axes; the shadcn table's own wrapper must not scroll too. */
export const scrollBoxClass = (expanded: boolean) =>
  cn(
    'overflow-auto overscroll-contain [&>[data-slot=table-container]]:overflow-visible',
    expanded ? 'min-h-0 flex-1' : 'max-h-[min(60vh,560px)]',
  )
