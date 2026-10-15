import type { Metadata, Viewport } from 'next'
import { DM_Sans, JetBrains_Mono } from 'next/font/google'
import { MotionConfig } from 'motion/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import './globals.css'

const dmSans = DM_Sans({
  variable: '--font-dm-sans',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
})

const jetbrainsMono = JetBrains_Mono({
  variable: '--font-jetbrains-mono',
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
})

export const metadata: Metadata = {
  title: { default: 'lume', template: '%s · lume' },
  description: 'Command center over the outbound pipelines.',
}

export const viewport: Viewport = {
  colorScheme: 'dark',
  themeColor: '#070711',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Dark mode only: the `dark` class is static so shadcn's `dark:` variants
  // and `@custom-variant dark` resolve without a theme provider.
  return (
    <html lang="en" className={`dark ${dmSans.variable} ${jetbrainsMono.variable}`}>
      <body className="antialiased">
        <div className="backdrop" aria-hidden />
        {/* reducedMotion="user": every `motion` component honours the OS setting. */}
        <MotionConfig reducedMotion="user">
          <TooltipProvider>{children}</TooltipProvider>
        </MotionConfig>
        <Toaster theme="dark" position="bottom-right" />
      </body>
    </html>
  )
}
