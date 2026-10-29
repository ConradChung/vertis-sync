import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { OPERATOR_COOKIE } from '@/lib/operators/cookie'
import { PageHead } from '@/components/shell/PageHead'
import { CampaignsScreen } from '@/components/campaigns/CampaignsScreen'

export const metadata: Metadata = { title: 'Campaigns' }

/** The reply-mode selector is editable only without a `lume_op` cookie (the route enforces it). */
export default async function CampaignsPage() {
  const canChangeReplyMode = !(await cookies()).get(OPERATOR_COOKIE)?.value
  return (
    <>
      <PageHead eyebrow="Stage 4" title="Campaigns" sub="Every campaign, its pipeline, and its replies — sends only after you confirm." />
      <CampaignsScreen canChangeReplyMode={canChangeReplyMode} />
    </>
  )
}
