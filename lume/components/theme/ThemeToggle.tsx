'use client'

import { Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { Button } from '@/components/ui/button'

/** Sun in dark mode (switch to light), moon in light. Icons swap by CSS, so SSR matches. */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Toggle colour theme"
      title="Toggle colour theme"
      onClick={() => setTheme(resolvedTheme === 'light' ? 'dark' : 'light')}
    >
      <Sun className="hidden dark:block" strokeWidth={1.75} aria-hidden />
      <Moon className="hidden light:block" strokeWidth={1.75} aria-hidden />
    </Button>
  )
}
