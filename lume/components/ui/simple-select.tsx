'use client'

import type { ReactNode, Ref } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

/** Base UI Select can't hold '' as an item value; it stands in for "none". */
const NONE = '__none__'

export interface SimpleOption {
  value: string
  label: ReactNode
}

export interface SimpleSelectProps {
  value: string
  onValueChange: (value: string) => void
  options: readonly SimpleOption[]
  id?: string
  'aria-label'?: string
  size?: 'sm' | 'default'
  disabled?: boolean
  className?: string
  triggerRef?: Ref<HTMLButtonElement>
}

/**
 * A string-valued shadcn Select with a native-`<select>`-shaped API: '' is a
 * real option (e.g. "All sources"), labels show in the trigger.
 */
export function SimpleSelect({ value, onValueChange, options, id, size = 'default', disabled, className, triggerRef, ...rest }: SimpleSelectProps) {
  const items = options.map((o) => ({ value: o.value === '' ? NONE : o.value, label: o.label }))
  return (
    <Select
      items={items}
      value={value === '' ? NONE : value}
      disabled={disabled}
      onValueChange={(v) => onValueChange(v == null || v === NONE ? '' : String(v))}
    >
      <SelectTrigger id={id} ref={triggerRef} aria-label={rest['aria-label']} size={size} className={cn('w-full min-w-0 text-[13px]', className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="w-auto min-w-(--anchor-width)">
        {items.map((i) => (
          <SelectItem key={i.value} value={i.value}>
            {i.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
