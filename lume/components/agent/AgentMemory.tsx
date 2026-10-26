'use client'

import { useCallback, useEffect, useState } from 'react'
import { Brain, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import type { Memory } from '@/lib/agent/memoryModel'
import { cn } from '@/lib/utils'

const KIND_LABEL: Record<Memory['kind'], string> = { client: 'Client', fact: 'Fact', preference: 'Preference', decision: 'Decision' }

/** What the agent remembers across chats; each item can be forgotten. */
export function AgentMemory({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [items, setItems] = useState<Memory[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(async () => {
    try {
      const res = await fetch('/api/agent/memory', { credentials: 'same-origin' })
      if (!res.ok) throw new Error(`Could not load memory (${res.status})`)
      setItems(((await res.json()) as { memories: Memory[] }).memories ?? [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load memory')
      setItems((v) => v ?? [])
    }
  }, [])
  useEffect(() => {
    if (open) void reload()
  }, [open, reload])

  const forget = async (id: string) => {
    setItems((v) => v?.filter((m) => m.id !== id) ?? null)
    const res = await fetch(`/api/agent/memory/${id}`, { method: 'DELETE', credentials: 'same-origin' }).catch(() => null)
    if (!res?.ok) void reload()
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full max-w-full p-5 pt-[calc(env(safe-area-inset-top)+3rem)] sm:w-[26rem] sm:pt-12">
        <SheetTitle className="flex items-center gap-2 text-[15px]">
          <Brain className="size-4 text-positive" /> Memory
        </SheetTitle>
        <SheetDescription className="mt-1 text-[12.5px] text-fg-46">
          What Lume learned in earlier chats. It reads these at the start of every chat. Forget anything wrong.
        </SheetDescription>
        {error && <p className="mt-4 text-[12.5px] text-destructive">{error}</p>}
        <ul className="mt-4 flex flex-col gap-2 overflow-y-auto" aria-label="Saved memories">
          {items === null ? (
            <li className="text-[13px] text-fg-46">Loading…</li>
          ) : items.length === 0 ? (
            <li className="rounded-control border border-dashed border-line px-3 py-4 text-center text-[13px] text-fg-46">
              Nothing saved yet. Tell the agent about a client, an ICP or a rule and it will remember.
            </li>
          ) : (
            items.map((m) => (
              <li key={m.id} className="group flex items-start gap-2 rounded-control border border-line bg-muted/40 px-3 py-2.5">
                <span
                  className={cn(
                    'mt-0.5 shrink-0 rounded-full border border-line px-1.5 py-px text-[10.5px] font-medium tracking-wide text-fg-70 uppercase',
                    m.kind === 'client' && 'border-primary/50 text-positive'
                  )}
                >
                  {KIND_LABEL[m.kind]}
                </span>
                <span className="min-w-0 flex-1 text-[13px] leading-5 text-fg">{m.content}</span>
                <Button variant="ghost" size="icon-xs" aria-label={`Forget: ${m.content}`} onClick={() => void forget(m.id)}>
                  <Trash2 className="size-3.5" />
                </Button>
              </li>
            ))
          )}
        </ul>
      </SheetContent>
    </Sheet>
  )
}
