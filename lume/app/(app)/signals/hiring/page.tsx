import type { Metadata } from 'next'
import { PageHead } from '@/components/shell/PageHead'
import { HiringSheet } from '@/components/signals/HiringSheet'
import { SignalsInbox } from '@/components/signals/SignalsInbox'
import { SignalsNav } from '@/components/signals/SignalsNav'

export const metadata: Metadata = { title: 'Hiring Ops Signal' }

/**
 * `/signals/hiring`: the Signals inbox filtered to hiring signals, then the
 * Hiring Ops sheet it always held (the drafted emails to copy, Sent / Skip,
 * the lanes and this month's spend).
 */
export default function HiringSignalPage() {
  return (
    <>
      <PageHead title="Hiring Ops Signal" actions={<SignalsNav current="hiring" />} />
      <div className="flex flex-col gap-12">
        <SignalsInbox fixedSource="hiring" />
        <section aria-label="Drafts and decisions" className="flex flex-col gap-4">
          <h2 className="text-[15px] font-medium text-fg">Drafts and decisions</h2>
          <HiringSheet />
        </section>
      </div>
    </>
  )
}
