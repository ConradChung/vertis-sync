import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/**
 * The one glass surface a page sits on (owner's design rules, 2026-11-26):
 * sections inside are set apart by whitespace, not by cards or dividers.
 * Radius and padding nest to 8px controls: 40 − 32 on desktop, 32 − 24 on phones.
 */
export function Surface({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('glass flex flex-col gap-12 rounded-[32px] p-6 sm:rounded-[40px] sm:p-8', className)} {...props} />
}
