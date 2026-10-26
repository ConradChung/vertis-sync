import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export type PageHeadProps = {
  /** Small uppercase label above the title, e.g. the stage name. */
  eyebrow?: string
  title: string
  /** One-line description under the title. */
  sub?: string
  /** Right-aligned slot for buttons. */
  actions?: ReactNode
  className?: string
}

export function PageHead({ eyebrow, title, sub, actions, className }: PageHeadProps) {
  return (
    <header className={cn('page-head', className)}>
      <div className="min-w-0">
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1 className="mt-[5px] text-2xl leading-tight font-semibold tracking-tight text-foreground">{title}</h1>
        {sub && <p className="mt-1.5 text-sm text-muted-foreground">{sub}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  )
}
