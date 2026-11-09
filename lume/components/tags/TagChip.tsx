'use client'

import { useState } from 'react'
import { useSWRConfig } from 'swr'
import { Check, Tag } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTags } from '@/hooks/useTags'
import { tagName, UNTAGGED, type TagTable } from '@/lib/tags/model'
import { sendJson } from '@/lib/validate/client'
import { cn } from '@/lib/utils'

export interface TagChipProps {
  /** Where the tag lives; null shows the tag read-only. */
  table: TagTable | null
  id: string
  verticalId: string | null | undefined
  /** The name the row came with (the list of tags may not be loaded yet). */
  name?: string | null
  /** After a successful change (re-read the list the item came from). */
  onChanged?: (verticalId: string | null) => void
  /** SWR keys to re-read after a change (the list the item came from). */
  revalidate?: readonly string[]
  /** The item is busy (a decision in flight): no retagging meanwhile. */
  disabled?: boolean
  className?: string
}

/**
 * An item's tag (its vertical) as quiet text: no box, no outline. Clicking
 * opens the tags plus "Untagged"; picking one PATCHes /api/tags at once.
 */
export function TagChip({ table, id, verticalId, name, onChanged, revalidate, disabled, className }: TagChipProps) {
  const [open, setOpenState] = useState(false)
  const [opened, setOpened] = useState(false)
  // The tag list loads only when needed: once the picker has opened, or when the row came without its tag's name.
  const { tags } = useTags(opened || (!!verticalId && !name))
  const setOpen = (o: boolean) => {
    if (o) setOpened(true)
    setOpenState(o)
  }
  const { mutate } = useSWRConfig()
  const [current, setCurrent] = useState<{ id: string | null; for: string | null | undefined } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A local pick shows until the row itself reports a new tag.
  const shown = current && current.for === verticalId ? current.id : (verticalId ?? null)
  const label = shown === (verticalId ?? null) ? tagName(shown, tags, name) : tagName(shown, tags)
  const text = (
    <>
      <Tag className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{label}</span>
    </>
  )
  const tone = shown ? 'text-violet-soft' : 'text-fg-46'
  const base = 'inline-flex max-w-[16rem] items-center gap-1 text-[11px] leading-none'

  if (!table) {
    return (
      <span className={cn(base, tone, className)} title={`Tag: ${label}`}>
        {text}
      </span>
    )
  }

  async function pick(next: string | null) {
    setOpen(false)
    if (next === shown) return
    setBusy(true)
    setError(null)
    const r = await sendJson<{ item?: { vertical_id: string | null }; error?: string }>('/api/tags', { table, id, vertical_id: next }, { method: 'PATCH' })
    setBusy(false)
    if (r.status === 200) {
      setCurrent({ id: r.body?.item?.vertical_id ?? next, for: verticalId })
      onChanged?.(next)
      for (const k of revalidate ?? []) void mutate(k)
    } else setError(r.body?.error ?? 'not saved')
  }

  const options: { id: string | null; name: string }[] = [...tags.map((t) => ({ id: t.id, name: t.name })), { id: null, name: UNTAGGED }]
  // Clicks and keys (the popup's too: React bubbles through the portal) stay here, so a clickable row or card doesn't open.
  return (
    <span className="inline-flex" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={`Tag: ${label}. Change tag`}
        title={error ? `Tag not saved: ${error}` : 'Change tag'}
        disabled={busy || disabled}
        className={cn(base, tone, 'cursor-pointer rounded-sm outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60', error && 'text-red', className)}
      >
        {text}
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-56 gap-0 rounded-xl bg-black/70 p-1 ring-0 backdrop-blur-2xl light:bg-white/70">
        <ul role="listbox" aria-label="Tags" className="flex flex-col">
          {options.map((o) => (
            <li key={o.id ?? 'untagged'} role="option" aria-selected={o.id === shown}>
              <button
                type="button"
                onClick={() => void pick(o.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] hover:bg-white/8',
                  o.id ? 'text-fg' : 'text-fg-46'
                )}
              >
                <span className="min-w-0 flex-1 truncate">{o.name}</span>
                {o.id === shown && <Check className="size-3.5 text-violet-soft" aria-hidden />}
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
    </span>
  )
}

/** "All · Kaspen · Job search …": the Progress tag filter, as plain text pills. */
export function TagFilter({
  options,
  value,
  onChange,
}: {
  options: { id: string | null; name: string; count: number }[]
  value: string
  onChange: (v: string) => void
}) {
  if (options.length < 2) return null
  const all = options.reduce((n, o) => n + o.count, 0)
  const items = [{ key: 'all', name: 'All', count: all }, ...options.map((o) => ({ key: o.id ?? 'untagged', name: o.name, count: o.count }))]
  return (
    <div role="radiogroup" aria-label="Filter by tag" className="flex flex-wrap items-center gap-x-1 gap-y-1 text-[12px]">
      {items.map((o, i) => (
        <span key={o.key} className="inline-flex items-center gap-1">
          {i > 0 && <span className="text-fg-24" aria-hidden>·</span>}
          <button
            type="button"
            role="radio"
            aria-checked={value === o.key}
            onClick={() => onChange(o.key)}
            className={cn('rounded-sm px-1 outline-none focus-visible:ring-2 focus-visible:ring-ring', value === o.key ? 'font-medium text-fg' : 'text-fg-46 hover:text-fg')}
          >
            {o.name}
            <span className="ml-1 font-mono text-[10.5px] text-fg-46 tabular-nums">{o.count}</span>
          </button>
        </span>
      ))}
    </div>
  )
}
