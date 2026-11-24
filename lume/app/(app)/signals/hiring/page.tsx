import type { Metadata } from 'next'
import { PageHead } from '@/components/shell/PageHead'
import { HiringSheet } from '@/components/signals/HiringSheet'

export const metadata: Metadata = { title: 'Hiring Ops Signal' }

export default function HiringSignalPage() {
  return (
    <>
      <PageHead
        eyebrow="Signals"
        title="Hiring Ops Signal"
        sub="Property managers hiring ops staff, new ops leaders and expansion news, each with an email from Frank to copy and send by hand. Nothing sends on its own."
      />
      <HiringSheet />
    </>
  )
}
