import type { Metadata } from 'next'
import { PageHead } from '@/components/shell/PageHead'

export const metadata: Metadata = { title: 'Import' }

export default function ImportPage() {
  return (
    <>
      <PageHead eyebrow="Stage 1" title="Import & Orders" sub="Apify, CSV and Apollo intake." />
      {/* Task 10: sources, orders table, ingest gates. */}
    </>
  )
}
