import { cn } from '@/lib/utils'

/**
 * The agent's own loader (owner, 2026-11-09): a lime core breathing inside
 * two counter-rotating orbits, with rings rippling out. Pure CSS
 * (`lume-*` keyframes in globals.css). `size="sm"` is the 16 px version for
 * the status pill; the large one centres in the chat while it loads.
 */
export function LumeLoader({ size = 'lg', label, className }: { size?: 'sm' | 'lg'; label?: string; className?: string }) {
  if (size === 'sm') {
    return (
      <span aria-hidden className={cn('relative inline-block size-4 shrink-0', className)}>
        <span className="absolute inset-[5px] rounded-full bg-primary shadow-[0_0_8px_var(--lime)] [animation:lume-breathe_1.6s_ease-in-out_infinite]" />
        <span className="absolute inset-0 [animation:lume-spin_1.1s_linear_infinite]">
          <span className="absolute top-0 left-1/2 size-1 -translate-x-1/2 rounded-full bg-primary" />
        </span>
      </span>
    )
  }
  return (
    <div role="status" aria-label={label ?? 'Loading'} className={cn('flex flex-col items-center justify-center gap-6', className)}>
      <div aria-hidden className="relative size-24">
        <span className="absolute inset-0 rounded-full border border-primary/50 [animation:lume-ripple_2.4s_cubic-bezier(0.2,0.6,0.3,1)_infinite]" />
        <span className="absolute inset-0 rounded-full border border-primary/50 [animation:lume-ripple_2.4s_cubic-bezier(0.2,0.6,0.3,1)_1.2s_infinite]" />
        <span className="absolute inset-[18px] rounded-full border border-dashed border-primary/25 [animation:lume-spin_9s_linear_infinite]" />
        <span className="absolute inset-[10px] [animation:lume-spin_1.6s_cubic-bezier(0.5,0.1,0.5,0.9)_infinite]">
          <span className="absolute top-0 left-1/2 size-2 -translate-x-1/2 rounded-full bg-primary shadow-[0_0_12px_var(--lime)]" />
        </span>
        <span className="absolute inset-[24px] [animation:lume-spin_2.4s_linear_infinite_reverse]">
          <span className="absolute bottom-0 left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-primary/70" />
        </span>
        <span className="absolute inset-[38px] rounded-full bg-primary shadow-[0_0_28px_6px_color-mix(in_oklab,var(--lime)_45%,transparent)] [animation:lume-breathe_2.4s_ease-in-out_infinite]" />
      </div>
      {label && <p className="bg-[linear-gradient(90deg,var(--fg-46),var(--lime),var(--fg-46))] bg-[length:200%_100%] bg-clip-text text-[13px] font-medium text-transparent [animation:lume-sheen_2.4s_linear_infinite]">{label}</p>}
    </div>
  )
}
