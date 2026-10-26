'use client'

import { useState } from 'react'
import { format } from 'date-fns'
import { CalendarIcon, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

/** 'yyyy-mm-dd' → a local Date (no UTC shift); anything else → undefined. */
export function parseIsoDate(v: string | undefined): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v ?? '')
  if (!m) return undefined
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(d.getTime()) ? undefined : d
}

export interface DatePickerProps {
  /** 'yyyy-mm-dd', or '' for none (same contract as `<input type="date">`). */
  value: string
  onChange: (value: string) => void
  id?: string
  'aria-label'?: string
  placeholder?: string
  size?: 'sm' | 'default'
  className?: string
}

/** shadcn date picker: a Popover + Calendar behind an outline button, with a clear control. */
export function DatePicker({ value, onChange, id, placeholder = 'Pick a date', size = 'default', className, ...rest }: DatePickerProps) {
  const [open, setOpen] = useState(false)
  const date = parseIsoDate(value)
  return (
    <div className={cn('relative inline-flex', className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              id={id}
              type="button"
              variant="outline"
              size={size}
              aria-label={rest['aria-label'] ? `${rest['aria-label']}: ${date ? format(date, 'd MMM yyyy') : 'none'}` : undefined}
              className={cn('w-full justify-start gap-2 font-normal tabular-nums', date ? 'pr-8 text-foreground' : 'text-muted-foreground')}
            />
          }
        >
          <CalendarIcon className="size-4" strokeWidth={1.75} aria-hidden />
          {date ? format(date, 'd MMM yyyy') : placeholder}
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={date}
            defaultMonth={date}
            onSelect={(d) => {
              onChange(d ? format(d, 'yyyy-MM-dd') : '')
              setOpen(false)
            }}
          />
        </PopoverContent>
      </Popover>
      {date && (
        <button
          type="button"
          aria-label="Clear date"
          onClick={() => onChange('')}
          className="absolute top-1/2 right-1.5 grid size-5 -translate-y-1/2 place-items-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-3.5" strokeWidth={1.75} aria-hidden />
        </button>
      )}
    </div>
  )
}
