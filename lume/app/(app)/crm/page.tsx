import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PageHead } from '@/components/shell/PageHead'
import { CrmScreen } from '@/components/crm/CrmScreen'

export const metadata: Metadata = { title: 'Pipeline' }

export default function CrmPage() {
  return (
    <>
      <PageHead eyebrow="Deals" title="Pipeline" sub="Every deal from first send to paid: Conversation, Demo, Pilot, Paid. Won and Lost only after you approve." />
      <Suspense>
        <CrmScreen />
      </Suspense>
    </>
  )
}
