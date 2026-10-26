'use client'

import { useEffect } from 'react'

/**
 * Mounts the Liquid Glass lens filter once (root layout) and turns lensing on
 * where it works.
 *
 * `backdrop-filter: url(#lume-lens)` only renders in Chromium; Safari and
 * Firefox parse it but drop the whole declaration (no blur either). CSS
 * `@supports` can't tell the difference, so we detect the engine here and
 * set `data-lg-lens` on <html>; globals.css only uses url() under that
 * attribute and falls back to blur + saturate everywhere else.
 */
export function LiquidGlassDefs() {
  useEffect(() => {
    const nav = navigator as Navigator & { userAgentData?: { brands?: { brand: string }[] } }
    const chromium = nav.userAgentData?.brands?.some((b) => b.brand === 'Chromium') ?? false
    if (chromium) document.documentElement.dataset.lgLens = ''
    return () => {
      delete document.documentElement.dataset.lgLens
    }
  }, [])

  return (
    <svg aria-hidden focusable="false" width="0" height="0" style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}>
      <defs>
        {/* Low-frequency noise → smooth displacement: the backdrop bends like
            light through a thick, slightly uneven pane rather than scattering. */}
        <filter id="lume-lens" x="0%" y="0%" width="100%" height="100%" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.0065 0.011" numOctaves="2" seed="7" result="noise" />
          <feGaussianBlur in="noise" stdDeviation="2.5" result="map" />
          <feDisplacementMap in="SourceGraphic" in2="map" scale="22" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
    </svg>
  )
}
