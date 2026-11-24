import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PageHead } from '@/components/shell/PageHead'
import { ImportTabs } from '@/components/import/ImportTabs'
import { LeadsScreen } from '@/components/leads/LeadsScreen'
import { stepEyebrow } from '@/lib/leads/steps'

export const metadata: Metadata = { title: 'Lead lists' }

export default function LeadListsPage() {
  return (
    <>
      <PageHead eyebrow={stepEyebrow(2, 3)} title="Lead lists" sub="Collect leads before the validator, combine sheets into a master, filter it into the final sheet, then send that to the usual ingest gate." />
      <ImportTabs active="leads" />
      <Suspense>
        <LeadsScreen />
      </Suspense>
    </>
  )
}
