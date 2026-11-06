import { validationStats, type BreakdownItem, type ReasonCount } from '@/lib/validate/stats'
import { cn } from '@/lib/utils'

const fmt = new Intl.NumberFormat('en-US')
const TONE: Record<BreakdownItem['status'], string> = { valid: 'bg-green', invalid: 'bg-red', error: 'bg-amber', no_email: 'bg-fg-24' }
// Shades so neighbouring invalid / error reasons stay apart in the bar.
const SHADE = ['opacity-100', 'opacity-75', 'opacity-55', 'opacity-40', 'opacity-30']

/**
 * The validator's verdicts for one job: the invalid rate (invalid ÷ (valid +
 * invalid)), errors and rows without an email shown apart, and a compact bar
 * plus legend by MailTester reason. Counts are grouped in SQL.
 */
export function ValidationBreakdown({ reasons }: { reasons: readonly ReasonCount[] }) {
  const s = validationStats(reasons)
  if (!s.breakdown.length) return null
  const shade = new Map<string, string>()
  for (const st of ['invalid', 'error'] as const) s.breakdown.filter((b) => b.status === st).forEach((b, i) => shade.set(`${st}:${b.label}`, SHADE[Math.min(i, SHADE.length - 1)]))
  const apart = [s.error ? `${fmt.format(s.error)} error${s.error === 1 ? '' : 's'} (${(s.error_rate ?? 0).toFixed(1)}%)` : '', s.no_email ? `${fmt.format(s.no_email)} without an email` : ''].filter(Boolean)
  return (
    <div role="group" aria-label="Validation results" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-[11px]">
        <span className="font-medium text-fg">{s.invalid_rate === null ? 'Invalid rate —' : `Invalid rate ${s.invalid_rate.toFixed(1)}%`}</span>
        <span className="text-fg-46">
          {fmt.format(s.invalid)} of {fmt.format(s.decided)} checked
          {apart.length > 0 && ` · ${apart.join(' and ')} ${apart.length > 1 ? 'are' : 'is'} not in the rate`}
        </span>
      </div>
      <div className="flex h-[6px] overflow-hidden rounded-full bg-muted" aria-hidden>
        {s.breakdown.map((b) => (
          <i key={`${b.status}:${b.label}`} className={cn('block h-full', TONE[b.status], shade.get(`${b.status}:${b.label}`))} style={{ width: `${b.pct}%` }} />
        ))}
      </div>
      <ul aria-label="By reason" className="flex flex-wrap gap-x-3 gap-y-1 text-[10.5px]">
        {s.breakdown.map((b) => (
          <li key={`${b.status}:${b.label}`} className="inline-flex items-center gap-1 text-fg-70">
            <i className={cn('inline-block size-2 rounded-full', TONE[b.status], shade.get(`${b.status}:${b.label}`))} aria-hidden />
            <span>{b.label}</span>
            <span className="font-mono text-fg tabular-nums">{fmt.format(b.n)}</span>
            <span className="font-mono text-fg-46 tabular-nums">{b.pct.toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
