import type { Metadata } from 'next'
import { PageHead } from '@/components/shell/PageHead'
import { ImportScreen } from '@/components/import/ImportScreen'

export const metadata: Metadata = { title: 'Import' }

export default function ImportPage() {
  return (
    <>
      <PageHead
        eyebrow="Stage 1"
        title="Import & Orders"
        sub="Apify, CSV and Apollo intake — every one waits at the same approval gate as Telegram."
      />
      <ImportScreen />
    </>
  )
}
