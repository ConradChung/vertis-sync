'use client'

import { useEffect, useRef, useState } from 'react'
import { useMicLevel } from '@/hooks/useMicLevel'
import { cn } from '@/lib/utils'

export type WaveMode = 'idle' | 'listening' | 'thinking'

const BARS = 28

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const on = () => setReduced(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return reduced
}

/** Resting shape: a soft hump, tallest in the middle. */
const base = (i: number) => {
  const d = Math.abs(i - (BARS - 1) / 2) / ((BARS - 1) / 2)
  return 0.18 + 0.22 * (1 - d * d)
}

/**
 * Wispr Flow–style voice bars. Idle: a slow breathing pulse. Listening: bars
 * follow the live mic level (AnalyserNode). Thinking: a travelling shimmer.
 * Heights are written straight to the DOM from one rAF loop (no re-renders);
 * `prefers-reduced-motion` gets static bars.
 */
export function Waveform({ mode, className }: { mode: WaveMode; className?: string }) {
  const bars = useRef<(HTMLSpanElement | null)[]>([])
  const levels = useRef<number[]>(Array.from({ length: BARS }, (_, i) => base(i)))
  const reduced = usePrefersReducedMotion()
  const mic = useMicLevel(mode === 'listening' && !reduced, BARS)

  useEffect(() => {
    const paint = (target: (i: number) => number, ease: number) => {
      for (let i = 0; i < BARS; i++) {
        const cur = levels.current[i]
        const next = cur + (target(i) - cur) * ease
        levels.current[i] = next
        const el = bars.current[i]
        if (el) el.style.transform = `scaleY(${next.toFixed(3)})`
      }
    }
    if (reduced) {
      paint(base, 1)
      return
    }
    let raf = 0
    const t0 = performance.now()
    const tick = (now: number) => {
      const t = (now - t0) / 1000
      if (mode === 'listening') {
        const live = mic.current?.()
        paint((i) => (live ? Math.max(0.1, Math.min(1, 0.12 + live[i] * 1.1)) : base(i) * (0.8 + 0.25 * Math.sin(t * 6 + i * 0.6))), 0.35)
      } else if (mode === 'thinking') {
        // A bright crest sweeping left → right over a gentle swell.
        const crest = ((t * 0.9) % 1.4) * BARS - 0.2 * BARS
        paint((i) => {
          const d = (i - crest) / 3.2
          return 0.16 + 0.12 * Math.sin(t * 3 + i * 0.45) ** 2 + 0.6 * Math.exp(-d * d)
        }, 0.2)
      } else {
        paint((i) => base(i) * (0.85 + 0.15 * Math.sin(t * 1.6 + i * 0.35)), 0.08)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [mode, reduced, mic])

  return (
    <div
      role="img"
      aria-label={mode === 'listening' ? 'Listening' : mode === 'thinking' ? 'Lume is working' : 'Lume is idle'}
      data-mode={mode}
      className={cn('flex h-10 items-center justify-center gap-1', className)}
    >
      {Array.from({ length: BARS }, (_, i) => (
        <span
          key={i}
          ref={(el) => {
            bars.current[i] = el
          }}
          className={cn(
            'block h-full w-1 origin-center rounded-full transition-colors duration-500',
            mode === 'listening' ? 'bg-white' : mode === 'thinking' ? 'bg-primary' : 'bg-white/30'
          )}
          style={{ transform: `scaleY(${base(i)})` }}
        />
      ))}
    </div>
  )
}
