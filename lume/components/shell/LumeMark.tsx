/** Lume's double-chevron mark. Inherits `currentColor`, so it follows the theme. */
export function LumeMark({ className }: { className?: string }) {
  return (
    <svg viewBox="505 315 505 385" className={className} fill="currentColor" stroke="currentColor" strokeWidth={6} strokeLinejoin="round" aria-hidden>
      <path d="M513 386 L766 510 L513 634 L607 510 Z" />
      <path d="M618 322 L732 322 Q752 322 768 334 L1003 508 L768 682 Q752 693 732 693 L616 690 L840 510 Z" />
    </svg>
  )
}
