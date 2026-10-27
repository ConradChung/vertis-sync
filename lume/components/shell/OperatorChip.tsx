import { cn } from '@/lib/utils'

/** "Operator: <vertical | Master>" — shown in the header while a Grok Bot's operator key holds the session. */
export function OperatorChip({ label, className }: { label: string; className?: string }) {
  return (
    <span
      title={`Signed in as the ${label} Grok Bot operator`}
      className={cn(
        'inline-flex h-7 max-w-[16rem] shrink-0 items-center truncate rounded-full border border-border bg-secondary px-2.5 text-xs text-muted-foreground',
        className
      )}
    >
      Operator: <span className="ml-1 truncate font-medium text-foreground">{label}</span>
    </span>
  )
}
