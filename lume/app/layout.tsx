import type { Metadata, Viewport } from 'next'
import { GeistSans } from 'geist/font/sans'
import { GeistMono } from 'geist/font/mono'
import { MotionConfig } from 'motion/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import { AppBackground } from '@/components/theme/AppBackground'
import { ThemeProvider } from '@/components/theme/ThemeProvider'
import './globals.css'

export const metadata: Metadata = {
  title: { default: 'lume', template: '%s · lume' },
  description: 'Command center over the outbound pipelines.',
}

export const viewport: Viewport = {
  colorScheme: 'dark light',
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#050505' },
    { media: '(prefers-color-scheme: light)', color: '#f3f6f0' },
  ],
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // next-themes sets `dark` / `light` on <html> before paint (class strategy,
  // default dark); suppressHydrationWarning covers that attribute change.
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <body className="antialiased">
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false} themes={['dark', 'light']} disableTransitionOnChange>
          <AppBackground />
          {/* reducedMotion="never": the owner chose to always animate, ignoring the OS setting. */}
          <MotionConfig reducedMotion="never">
            <TooltipProvider>{children}</TooltipProvider>
          </MotionConfig>
          <Toaster position="bottom-right" />
        </ThemeProvider>
      </body>
    </html>
  )
}
