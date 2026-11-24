import type { Metadata } from 'next'
import { PageHead } from '@/components/shell/PageHead'
import { ImportScreen } from '@/components/import/ImportScreen'
import { ImportTabs } from '@/components/import/ImportTabs'
import { stepEyebrow } from '@/lib/leads/steps'

export const metadata: Metadata = { title: 'Import' }

export default function ImportPage() {
  return (
    <>
      <PageHead
        eyebrow={stepEyebrow(1)}
        title="Import & Orders"
        sub="Apify, CSV and Apollo intake — every one waits at the same approval gate as Telegram."
      />
      <ImportTabs active="intake" />
      <ImportScreen />
    </>
  )
}
