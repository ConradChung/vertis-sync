import { Suspense } from 'react'
import type { Metadata } from 'next'
import { PageHead } from '@/components/shell/PageHead'
import { CalendarScreen } from '@/components/calendar/CalendarScreen'

export const metadata: Metadata = { title: 'Calendar' }

export default function CalendarPage() {
  return (
    <>
      <PageHead
        eyebrow="Plan"
        title="Calendar"
        sub="Scheduled tasks, mirrored to Linear for sprints. A task with an action asks for your tap when it falls due — nothing runs on its own."
      />
      {/* useSearchParams (the ?task= deep link) needs a Suspense boundary. */}
      <Suspense fallback={null}>
        <CalendarScreen />
      </Suspense>
    </>
  )
}
