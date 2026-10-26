import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PageHead } from '@/components/shell/PageHead'
import { CrmScreen } from '@/components/crm/CrmScreen'

export const metadata: Metadata = { title: 'CRM' }

export default function CrmPage() {
  return (
    <>
      <PageHead eyebrow="Pipeline" title="CRM" sub="Every campaign's deals, from first send to won — Won and Lost only after you approve." />
      <Suspense>
        <CrmScreen />
      </Suspense>
    </>
  )
}
