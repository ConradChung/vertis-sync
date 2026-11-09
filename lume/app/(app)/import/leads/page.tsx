import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PageHead } from '@/components/shell/PageHead'
import { ImportTabs } from '@/components/import/ImportTabs'
import { LeadsScreen } from '@/components/leads/LeadsScreen'

export const metadata: Metadata = { title: 'Lead lists' }

export default function LeadListsPage() {
  return (
    <>
      <PageHead eyebrow="Step 2" title="Lead lists" sub="Collect leads before the validator: you and the agent add to them; send one to the usual ingest gate when it is ready." />
      <ImportTabs active="leads" />
      <Suspense>
        <LeadsScreen />
      </Suspense>
    </>
  )
}
