/** Bounce rate: bounced ÷ sent, as a percent with one decimal. null when nothing was sent or a number is unknown. */
export function bounceRate(bounced: number | null | undefined, sent: number | null | undefined): number | null {
  if (bounced == null || sent == null || !(sent > 0)) return null
  return Math.round((bounced / sent) * 1000) / 10
}

export type BounceTone = 'green' | 'amber' | 'red' | 'none'

/** The deliverability bands: under 2 % healthy, 2-5 % watch, over 5 % harming the sending domain. */
export function bounceTone(rate: number | null): BounceTone {
  if (rate === null) return 'none'
  if (rate < 2) return 'green'
  if (rate <= 5) return 'amber'
  return 'red'
}

export const BOUNCE_TONE_TEXT: Record<BounceTone, string> = {
  green: 'text-green',
  amber: 'text-amber',
  red: 'text-red',
  none: 'text-fg-24',
}

export const BOUNCE_HINT = 'Bounced ÷ sent. Under 2% is healthy, 2–5% needs watching, over 5% hurts the sending domain.'

export const formatBounceRate = (r: number | null): string => (r === null ? '—' : `${r.toFixed(1)}%`)
