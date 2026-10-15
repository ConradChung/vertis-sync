import type { Metadata } from 'next'
import { PageHead } from '@/components/shell/PageHead'

export const metadata: Metadata = { title: 'Validate' }

export default function ValidatePage() {
  return (
    <>
      <PageHead eyebrow="Stage 2" title="Validate" sub="Gates, batches and verdicts." />
      {/* Task 9: validation queue, gate decisions, results. */}
    </>
  )
}
