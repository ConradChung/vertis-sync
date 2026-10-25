import type { Metadata } from 'next'
import { PageHead } from '@/components/shell/PageHead'
import { RotateScreen } from '@/components/rotate/RotateScreen'

export const metadata: Metadata = { title: 'Rotate' }

export default function RotatePage() {
  return (
    <>
      <PageHead
        eyebrow="Stage 3"
        title="Rotate"
        sub="Lead bank, campaign capacity and rotation rules — every assignment waits for your tap."
      />
      <RotateScreen />
    </>
  )
}
