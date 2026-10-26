'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { CrmWorkspace } from '@/components/crm/CrmWorkspace'

/** Top-level /crm: the same console with a campaign switcher; `?campaign=` (default all). */
export function CrmScreen() {
  const params = useSearchParams()
  const router = useRouter()
  const campaign = params.get('campaign') || 'all'
  const deal = params.get('deal')
  return (
    <CrmWorkspace
      campaignId={campaign}
      switcher
      initialDealId={deal && /^[0-9a-f-]{36}$/i.test(deal) ? deal : null}
      onCampaignChange={(id) => router.replace(id === 'all' ? '/crm' : `/crm?campaign=${encodeURIComponent(id)}`, { scroll: false })}
      crumbs={[{ label: 'CRM', href: '/crm' }, { label: campaign === 'all' ? 'All campaigns' : 'Pipeline' }]}
    />
  )
}
