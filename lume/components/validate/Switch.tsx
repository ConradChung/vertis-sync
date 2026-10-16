'use client'

import { cn } from '@/lib/utils'

/** Small on/off switch (button role="switch"); the label text is the accessible name. */
export function Switch({
  checked,
  onChange,
  disabled,
  label,
  hint,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  label: string
  hint?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="group flex w-full items-center gap-3 rounded-[9px] px-2 py-1.5 text-left outline-none hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
    >
      <span
        aria-hidden
        className={cn(
          'relative inline-flex h-[18px] w-[30px] shrink-0 rounded-full border transition-colors duration-200',
          checked ? 'border-violet/70 bg-violet/70' : 'border-white/15 bg-white/8'
        )}
      >
        <span
          className={cn(
            'absolute top-[2px] left-[2px] size-[12px] rounded-full bg-white transition-transform duration-200',
            checked && 'translate-x-[12px]'
          )}
        />
      </span>
      <span className="min-w-0">
        <span className="block text-[12px] text-fg">{label}</span>
        {hint && <span className="block text-[10px] text-fg-46">{hint}</span>}
      </span>
    </button>
  )
}
