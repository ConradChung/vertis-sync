'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ClipboardList,
  BookOpen,
  BarChart2,
  LogOut,
  Rocket,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Sidebar, SidebarBody, useSidebar } from '@/components/ui/sidebar'
import CampaignAnalytics from '@/components/CampaignAnalytics'
import DocuSignSection from '@/components/onboarding/DocuSignSection'
import StageProgress from '@/components/onboarding/StageProgress'
import Stage1 from '@/components/onboarding/Stage1'
import Stage2 from '@/components/onboarding/Stage2'
import Stage3 from '@/components/onboarding/Stage3'
import OnboardingComplete from '@/components/onboarding/OnboardingComplete'
import ModulesSection from '@/components/modules/ModulesSection'

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

type Tab = 'onboarding' | 'modules' | 'analytics'

// ── Sidebar sub-components (must be inside SidebarProvider to use useSidebar) ──

function SidebarLogo() {
  const { open, animate } = useSidebar()
  return (
    <div className="flex items-center gap-3 px-3 py-2 mb-2">
      <div className="w-7 h-7 rounded-lg bg-[#5E6AD2] flex items-center justify-center shrink-0">
        <Rocket size={14} className="text-white" />
      </div>
      <motion.span
        animate={{
          display: animate ? (open ? 'inline-block' : 'none') : 'inline-block',
          opacity: animate ? (open ? 1 : 0) : 1,
        }}
        className="text-[13px] font-semibold text-white whitespace-nowrap"
      >
        NorthStar
      </motion.span>
    </div>
  )
}

function NavItem({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  active: boolean
  onClick: () => void
}) {
  const { open, animate } = useSidebar()
  return (
    <button
      onClick={onClick}
      className={cn(
        'relative flex items-center gap-3 px-3 py-2.5 rounded-lg w-full text-left transition-colors',
        active ? 'text-white' : 'text-[#5A5A5A] hover:text-[#A0A0A0]'
      )}
    >
      {active && (
        <motion.div
          layoutId="sidebar-active-bg"
          className="absolute inset-0 rounded-lg bg-white/5 border border-white/8"
          transition={{ type: 'spring', stiffness: 400, damping: 35 }}
        />
      )}
      <span className="relative shrink-0">{icon}</span>
      <motion.span
        animate={{
          display: animate ? (open ? 'inline-block' : 'none') : 'inline-block',
          opacity: animate ? (open ? 1 : 0) : 1,
        }}
        className="relative text-[13px] font-medium whitespace-nowrap"
      >
        {label}
      </motion.span>
    </button>
  )
}

function SidebarUserFooter({
  companyName,
  email,
  onLogout,
}: {
  companyName: string
  email: string
  onLogout: () => void
}) {
  const { open, animate } = useSidebar()
  const initial = ((companyName || email || 'U')[0] || 'U').toUpperCase()

  return (
    <div className="border-t border-[#1E1E1E] pt-4 space-y-1">
      <div className="flex items-center gap-3 px-3 py-2">
        <div className="w-7 h-7 rounded-full bg-[#2A2A2A] flex items-center justify-center shrink-0 text-[11px] text-white font-medium">
          {initial}
        </div>
        <motion.span
          animate={{
            display: animate ? (open ? 'inline-block' : 'none') : 'inline-block',
            opacity: animate ? (open ? 1 : 0) : 1,
          }}
          className="text-[12px] text-[#5A5A5A] truncate whitespace-nowrap max-w-[160px]"
        >
          {companyName || email}
        </motion.span>
      </div>
      <button
        onClick={onLogout}
        className="relative flex items-center gap-3 px-3 py-2.5 rounded-lg w-full text-left text-[#5A5A5A] hover:text-[#A0A0A0] transition-colors"
      >
        <LogOut size={18} className="shrink-0" />
        <motion.span
          animate={{
            display: animate ? (open ? 'inline-block' : 'none') : 'inline-block',
            opacity: animate ? (open ? 1 : 0) : 1,
          }}
          className="text-[13px] font-medium whitespace-nowrap"
        >
          Log out
        </motion.span>
      </button>
    </div>
  )
}

// ── Main dashboard ──

export default function ClientDashboard({
  profile,
  campaigns,
}: {
  profile: Profile
  campaigns: Campaign[]
}) {
  const [acknowledged, setAcknowledged] = useState(profile.docusign_acknowledged)
  const [currentStage, setCurrentStage] = useState(profile.onboarding_stage || 0)
  const [activeTab, setActiveTab] = useState<Tab>('onboarding')
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

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const hasAnalytics = campaigns.length > 0

  const navItems: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'onboarding', label: 'Onboarding', icon: <ClipboardList size={18} /> },
    { id: 'modules', label: 'Modules', icon: <BookOpen size={18} /> },
    ...(hasAnalytics
      ? [{ id: 'analytics' as Tab, label: 'Analytics', icon: <BarChart2 size={18} /> }]
      : []),
  ]

  return (
    <div className="flex h-screen bg-[#0A0A0A] overflow-hidden">
      <Sidebar animate={false}>
        <SidebarBody className="!bg-[#0A0A0A] !border-r !border-[#1E1E1E] !w-[220px] justify-between gap-8">
          <div className="flex flex-col flex-1 overflow-y-auto overflow-x-hidden gap-0.5">
            <SidebarLogo />
            <div className="mt-2 flex flex-col gap-0.5">
              {navItems.map(item => (
                <NavItem
                  key={item.id}
                  icon={item.icon}
                  label={item.label}
                  active={activeTab === item.id}
                  onClick={() => setActiveTab(item.id)}
                />
              ))}
            </div>
          </div>
          <SidebarUserFooter
            companyName={profile.company_name}
            email={profile.email}
            onLogout={handleLogout}
          />
        </SidebarBody>
      </Sidebar>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto bg-[#0A0A0A]">
        <AnimatePresence mode="wait">
          {activeTab === 'onboarding' && (
            <motion.div
              key="onboarding"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="max-w-3xl mx-auto px-6 py-8 space-y-8"
            >
              <DocuSignSection
                url={profile.docusign_url}
                acknowledged={acknowledged}
                onAcknowledge={handleAcknowledge}
              />

              {acknowledged && currentStage >= 1 && currentStage <= 3 && (
                <>
                  <StageProgress currentStage={currentStage} />
                  <div className="border border-[#1E1E1E] rounded-xl p-6">
                    {currentStage === 1 && (
                      <Stage1
                        companyName={profile.company_name}
                        onComplete={() => setCurrentStage(2)}
                      />
                    )}
                    {currentStage === 2 && (
                      <Stage2 onComplete={() => setCurrentStage(3)} />
                    )}
                    {currentStage === 3 && (
                      <Stage3 onComplete={() => setCurrentStage(4)} />
                    )}
                  </div>
                </>
              )}

              {acknowledged && currentStage >= 4 && (
                <>
                  <StageProgress currentStage={4} />
                  <div className="border border-[#1E1E1E] rounded-xl p-6">
                    <OnboardingComplete
                      hasCampaign={hasAnalytics}
                      onViewCampaign={
                        hasAnalytics
                          ? () => {
                              setShowAnalytics(true)
                              setActiveTab('analytics')
                            }
                          : undefined
                      }
                      onViewModules={() => setActiveTab('modules')}
                    />
                  </div>
                </>
              )}

              {showAnalytics && activeCampaign && currentStage >= 4 && (
                <CampaignAnalytics
                  campaignId={activeCampaign.instantly_campaign_id}
                  campaignName={activeCampaign.campaign_name}
                />
              )}
            </motion.div>
          )}

          {activeTab === 'modules' && (
            <motion.div
              key="modules"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="max-w-3xl mx-auto px-6 py-8"
            >
              <ModulesSection />
            </motion.div>
          )}

          {activeTab === 'analytics' && hasAnalytics && activeCampaign && (
            <motion.div
              key="analytics"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="max-w-3xl mx-auto px-6 py-8"
            >
              <CampaignAnalytics
                campaignId={activeCampaign.instantly_campaign_id}
                campaignName={activeCampaign.campaign_name}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  )
}
