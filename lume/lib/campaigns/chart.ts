/** True when every series value across every point is 0 (e.g. a paused campaign's last 7 days). */
export function allZero<T extends object>(points: T[], keys: (keyof T)[]): boolean {
  return points.every((p) => keys.every((k) => !p[k]))
}

/** Latest date with any activity, or undefined. `daily` need not be sorted. */
export function lastActiveDate(daily: { date: string; sent: number; replies: number; opportunities: number }[]): string | undefined {
  let best: string | undefined
  for (const p of daily) if ((p.sent || p.replies || p.opportunities) && (!best || p.date > best)) best = p.date
  return best
}
