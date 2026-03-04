'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import CampaignAnalytics from '@/components/CampaignAnalytics'
import DocuSignSection from '@/components/onboarding/DocuSignSection'
import StageProgress from '@/components/onboarding/StageProgress'
import Stage1 from '@/components/onboarding/Stage1'
import Stage2 from '@/components/onboarding/Stage2'
import Stage3 from '@/components/onboarding/Stage3'
import OnboardingComplete from '@/components/onboarding/OnboardingComplete'

interface Profile {
  id: string
  email: string
  company_name: string
  role: string
  docusign_url: string | null
  onboarding_stage: number
  docusign_acknowledged: boolean
}

interface Campaign {
  id: string
  instantly_campaign_id: string
  campaign_name: string
  status: string
}

export default function ClientDashboard({
  profile,
  campaigns,
}: {
  profile: Profile
  campaigns: Campaign[]
}) {
  const [acknowledged, setAcknowledged] = useState(profile.docusign_acknowledged)
  const [currentStage, setCurrentStage] = useState(profile.onboarding_stage || 0)
  const [showAnalytics, setShowAnalytics] = useState(false)
  const [activeCampaign] = useState<Campaign | null>(campaigns[0] ?? null)

  const router = useRouter()
  const supabase = createClient()

  const handleAcknowledge = async () => {
    await supabase
      .from('profiles')
      .update({ docusign_acknowledged: true, onboarding_stage: 1 })
      .eq('id', profile.id)
    setAcknowledged(true)
    setCurrentStage(1)
  }

  const advanceStage = () => setCurrentStage(s => s + 1)

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  return (
    <div className="min-h-screen bg-[#0A0A0A]">
      {/* Header */}
      <header className="border-b border-[#1E1E1E]">
        <div className="mx-auto max-w-3xl px-6 py-4 flex items-center justify-between">
          <p className="text-sm font-medium text-white">{profile.company_name || 'Dashboard'}</p>
          <button
            onClick={handleLogout}
            className="text-[13px] text-[#6B6B6B] hover:text-white transition-colors"
          >
            Log out
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-3xl px-6 py-8 space-y-8">
        {/* DocuSign — always visible until acknowledged */}
        <DocuSignSection
          url={profile.docusign_url}
          acknowledged={acknowledged}
          onAcknowledge={handleAcknowledge}
        />

        {/* Onboarding flow */}
        {acknowledged && currentStage >= 1 && currentStage <= 3 && (
          <>
            <StageProgress currentStage={currentStage} />
            <div className="border border-[#1E1E1E] rounded p-6">
              {currentStage === 1 && (
                <Stage1
                  companyName={profile.company_name}
                  onComplete={() => { setCurrentStage(2) }}
                />
              )}
              {currentStage === 2 && (
                <Stage2 onComplete={() => setCurrentStage(3)} />
              )}
              {currentStage === 3 && (
                <Stage3 onComplete={advanceStage} />
              )}
            </div>
          </>
        )}

        {/* Completion screen */}
        {acknowledged && currentStage >= 4 && (
          <>
            <StageProgress currentStage={4} />
            <div className="border border-[#1E1E1E] rounded p-6">
              <OnboardingComplete
                hasCampaign={campaigns.length > 0}
                onViewCampaign={() => setShowAnalytics(true)}
              />
            </div>

            {/* Campaign analytics — shown after completion if campaign exists */}
            {showAnalytics && activeCampaign && (
              <CampaignAnalytics
                campaignId={activeCampaign.instantly_campaign_id}
                campaignName={activeCampaign.campaign_name}
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}
