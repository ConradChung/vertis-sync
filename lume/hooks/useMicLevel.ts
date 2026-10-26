'use client'

import { useEffect, useRef } from 'react'

/**
 * While `active`, opens the mic and keeps a Web Audio AnalyserNode on it.
 * Returns a ref to a reader of `n` band levels in 0..1 (null when inactive or
 * the mic is unavailable). Polled from an animation frame: no re-renders.
 */
export function useMicLevel(active: boolean, n: number) {
  const reader = useRef<(() => number[]) | null>(null)

  useEffect(() => {
    if (!active || typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return
    let cancelled = false
    let stream: MediaStream | null = null
    let ctx: AudioContext | null = null

    navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop())
          return
        }
        stream = s
        const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        if (!Ctx) return
        ctx = new Ctx()
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 256
        analyser.smoothingTimeConstant = 0.75
        ctx.createMediaStreamSource(s).connect(analyser)
        const bins = new Uint8Array(analyser.frequencyBinCount)
        // Voice lives in the low ~third of the spectrum; spread it over the bars.
        const usable = Math.floor(bins.length * 0.4)
        reader.current = () => {
          analyser.getByteFrequencyData(bins)
          const out: number[] = []
          for (let i = 0; i < n; i++) {
            // Mirror around the centre so the waveform is symmetric.
            const d = Math.abs(i - (n - 1) / 2) / ((n - 1) / 2)
            const idx = Math.min(usable - 1, Math.floor(d * usable))
            out.push(bins[idx] / 255)
          }
          return out
        }
      })
      .catch(() => {
        reader.current = null
      })

    return () => {
      cancelled = true
      reader.current = null
      stream?.getTracks().forEach((t) => t.stop())
      void ctx?.close()
    }
  }, [active, n])

  return reader
}
