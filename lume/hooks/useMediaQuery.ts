'use client'

import { useEffect, useState } from 'react'

/** Below Tailwind `sm` — phones. */
export const PHONE_QUERY = '(max-width: 639.98px)'

/** Matches a media query on the client (false during SSR, and where matchMedia is missing, e.g. jsdom). */
export function useMediaQuery(query: string): boolean {
  const [on, setOn] = useState(false)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(query)
    const update = () => setOn(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [query])
  return on
}
