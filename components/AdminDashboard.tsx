'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Users,
  Megaphone,
  ClipboardList,
  Database,
  Mail,
  LogOut,
  Rocket,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Sidebar, SidebarBody, useSidebar } from '@/components/ui/sidebar'
import CampaignAnalytics from '@/components/CampaignAnalytics'
import EmailValidator from '@/components/EmailValidator'

interface Client {
  id: string
  email: string
  company_name: string
  created_at: string
  docusign_url: string | null
  onboarding_stage: number
}

interface Campaign {
  id: string
  client_id: string
  instantly_campaign_id: string
  campaign_name: string
  status: string
}

interface OnboardingStep {
  id: string
  client_id: string
  step_title: string
  step_description: string
  completed: boolean
  order: number
}

type Section = 'clients' | 'campaigns' | 'onboarding' | 'onboarding-data' | 'email-validator'

// ── Sidebar sub-components ──

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
          layoutId="admin-sidebar-active"
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

function SidebarAdminFooter({ onLogout }: { onLogout: () => void }) {
  const { open, animate } = useSidebar()
  return (
    <div className="border-t border-[#1E1E1E] pt-4">
      <button
        onClick={onLogout}
        className="flex items-center gap-3 px-3 py-2.5 rounded-lg w-full text-left text-[#5A5A5A] hover:text-[#A0A0A0] transition-colors"
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

// ── Shared input style ──
const inputCls = 'w-full px-3 py-2 bg-[#0F0F0F] border border-[#1E1E1E] rounded-lg text-[13px] text-white placeholder-[#4A4A4A] focus:outline-none focus:border-[#3A3A3A]'
const btnPrimary = 'px-4 py-2 bg-white text-[#0A0A0A] text-[13px] font-medium rounded-lg hover:bg-[#E0E0E0] transition-colors'

const STAGE_LABELS: Record<number, string> = {
  0: 'Pre-start', 1: 'Stage 1', 2: 'Stage 2', 3: 'Stage 3', 4: 'Complete',
}

export default function AdminDashboard() {
  const [clients, setClients] = useState<Client[]>([])
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [onboardingSteps, setOnboardingSteps] = useState<OnboardingStep[]>([])
  const [selectedClient, setSelectedClient] = useState<string | null>(null)
  const [showCreateClient, setShowCreateClient] = useState(false)
  const [showAddCampaign, setShowAddCampaign] = useState(false)
  const [showAddStep, setShowAddStep] = useState(false)
  const [activeSection, setActiveSection] = useState<Section>('clients')
  const [selectedCampaign, setSelectedCampaign] = useState<Campaign | null>(null)
  const [docuSignInputs, setDocuSignInputs] = useState<Record<string, string>>({})
  const [onboardingDataClientId, setOnboardingDataClientId] = useState<string>('')
  const [stageData, setStageData] = useState<{ stage1: Record<string, unknown> | null; stage2: Record<string, unknown> | null; stage3: Record<string, unknown> | null }>({ stage1: null, stage2: null, stage3: null })

  const router = useRouter()
  const supabase = createClient()

  useEffect(() => {
    loadClients()
    loadCampaigns()
    loadOnboardingSteps()
  }, [])

  const loadClients = async () => {
    const { data } = await supabase.from('profiles').select('*').eq('role', 'client').order('created_at', { ascending: false })
    if (data) setClients(data)
  }

  const loadCampaigns = async () => {
    const { data } = await supabase.from('campaigns').select('*').order('created_at', { ascending: false })
    if (data) setCampaigns(data)
  }

  const loadOnboardingSteps = async () => {
    const { data } = await supabase.from('onboarding_steps').select('*').order('client_id', { ascending: true }).order('order', { ascending: true })
    if (data) setOnboardingSteps(data)
  }

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const handleCreateClient = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    const email = fd.get('email') as string
    const password = fd.get('password') as string
    const companyName = fd.get('company_name') as string

    const { data: authData, error: authError } = await supabase.auth.signUp({
      email, password, options: { data: { company_name: companyName } },
    })
    if (authError) { alert(`Error: ${authError.message}`); return }
    if (authData.user) {
      const { error } = await supabase.from('profiles').insert({ id: authData.user.id, email, role: 'client', company_name: companyName })
      if (error) { alert(`Error: ${error.message}`); return }
      setShowCreateClient(false)
      loadClients()
      ;(e.target as HTMLFormElement).reset()
    }
  }

  const handleAddCampaign = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    const { error } = await supabase.from('campaigns').insert({
      client_id: fd.get('client_id'),
      instantly_campaign_id: fd.get('instantly_campaign_id'),
      campaign_name: fd.get('campaign_name'),
      status: 'active',
    })
    if (error) { alert(`Error: ${error.message}`); return }
    setShowAddCampaign(false)
    loadCampaigns()
    ;(e.target as HTMLFormElement).reset()
  }

  const handleAddStep = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    const { error } = await supabase.from('onboarding_steps').insert({
      client_id: fd.get('client_id'),
      step_title: fd.get('step_title'),
      step_description: fd.get('step_description'),
      order: parseInt(fd.get('order') as string),
      completed: false,
    })
    if (error) { alert(`Error: ${error.message}`); return }
    setShowAddStep(false)
    loadOnboardingSteps()
    ;(e.target as HTMLFormElement).reset()
  }

  const toggleStepCompletion = async (stepId: string, current: boolean) => {
    const { error } = await supabase.from('onboarding_steps').update({ completed: !current }).eq('id', stepId)
    if (error) { alert(`Error: ${error.message}`); return }
    loadOnboardingSteps()
  }

  const saveDocuSignUrl = async (clientId: string, url: string) => {
    await supabase.from('profiles').update({ docusign_url: url || null }).eq('id', clientId)
    setClients(prev => prev.map(c => c.id === clientId ? { ...c, docusign_url: url || null } : c))
  }

  const loadStageData = async (clientId: string) => {
    const [s1, s2, s3] = await Promise.all([
      supabase.from('stage1_onboarding').select('*').eq('client_id', clientId).single(),
      supabase.from('stage2_onboarding').select('*').eq('client_id', clientId).single(),
      supabase.from('onboarding_forms').select('*').eq('client_id', clientId).single(),
    ])
    setStageData({ stage1: s1.data, stage2: s2.data, stage3: s3.data })
  }

  const filteredCampaigns = selectedClient ? campaigns.filter(c => c.client_id === selectedClient) : campaigns
  const filteredSteps = selectedClient ? onboardingSteps.filter(s => s.client_id === selectedClient) : onboardingSteps

  const navItems: { id: Section; label: string; icon: React.ReactNode }[] = [
    { id: 'clients', label: 'Clients', icon: <Users size={18} /> },
    { id: 'campaigns', label: 'Campaigns', icon: <Megaphone size={18} /> },
    { id: 'onboarding', label: 'Onboarding', icon: <ClipboardList size={18} /> },
    { id: 'onboarding-data', label: 'Onboarding Data', icon: <Database size={18} /> },
    { id: 'email-validator', label: 'Email Validator', icon: <Mail size={18} /> },
  ]

  const navigate = (section: Section) => {
    setActiveSection(section)
    setSelectedCampaign(null)
  }

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
                  active={activeSection === item.id}
                  onClick={() => navigate(item.id)}
                />
              ))}
            </div>
          </div>
          <SidebarAdminFooter onLogout={handleLogout} />
        </SidebarBody>
      </Sidebar>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto bg-[#0A0A0A]">
        <AnimatePresence mode="wait">

          {/* ── Clients ── */}
          {activeSection === 'clients' && (
            <motion.div key="clients" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
              className="max-w-3xl mx-auto px-6 py-8">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-base font-medium text-white">Clients</h2>
                <button onClick={() => setShowCreateClient(v => !v)} className={btnPrimary}>
                  Create Client
                </button>
              </div>

              {showCreateClient && (
                <form onSubmit={handleCreateClient} className="mb-5 p-5 border border-[#1E1E1E] rounded-xl space-y-3">
                  <input name="email" type="email" placeholder="Email" required className={inputCls} />
                  <input name="password" type="password" placeholder="Password" required className={inputCls} />
                  <input name="company_name" type="text" placeholder="Company Name" required className={inputCls} />
                  <button type="submit" className={`${btnPrimary} w-full`}>Create</button>
                </form>
              )}

              <div className="space-y-2">
                {clients.map(client => (
                  <div key={client.id} className="border border-[#1E1E1E] rounded-xl p-4">
                    <div className="flex items-center justify-between cursor-pointer"
                      onClick={() => setSelectedClient(client.id === selectedClient ? null : client.id)}>
                      <div>
                        <p className="text-[13px] font-medium text-white">{client.company_name || 'Unnamed'}</p>
                        <p className="text-[12px] text-[#5A5A5A] mt-0.5">{client.email}</p>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className={`text-[11px] px-2 py-0.5 rounded-full border ${
                          client.onboarding_stage >= 4
                            ? 'border-[#2ECC71]/30 text-[#2ECC71] bg-[#2ECC71]/5'
                            : client.onboarding_stage > 0
                            ? 'border-[#5E6AD2]/30 text-[#5E6AD2] bg-[#5E6AD2]/5'
                            : 'border-[#2A2A2A] text-[#4A4A4A]'
                        }`}>
                          {STAGE_LABELS[client.onboarding_stage] || 'Pre-start'}
                        </span>
                        <span className="text-[11px] text-[#4A4A4A]">
                          {new Date(client.created_at).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                    <div className="mt-3 flex gap-2" onClick={e => e.stopPropagation()}>
                      <input
                        type="text"
                        value={docuSignInputs[client.id] ?? client.docusign_url ?? ''}
                        onChange={e => setDocuSignInputs(prev => ({ ...prev, [client.id]: e.target.value }))}
                        onBlur={e => saveDocuSignUrl(client.id, e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && saveDocuSignUrl(client.id, docuSignInputs[client.id] ?? '')}
                        placeholder="DocuSign URL (paste link to save)"
                        className="flex-1 px-2.5 py-1.5 bg-[#0A0A0A] border border-[#1E1E1E] rounded-lg text-[12px] text-white placeholder-[#3A3A3A] focus:outline-none focus:border-[#3A3A3A]"
                      />
                      {(docuSignInputs[client.id] ?? client.docusign_url) && (
                        <span className="text-[11px] text-[#2ECC71] flex items-center">✓</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </motion.div>
          )}

          {/* ── Campaigns ── */}
          {activeSection === 'campaigns' && !selectedCampaign && (
            <motion.div key="campaigns" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
              className="max-w-3xl mx-auto px-6 py-8">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-base font-medium text-white">Campaigns</h2>
                <button onClick={() => setShowAddCampaign(v => !v)} className={btnPrimary}>
                  Add Campaign
                </button>
              </div>

              {showAddCampaign && (
                <form onSubmit={handleAddCampaign} className="mb-5 p-5 border border-[#1E1E1E] rounded-xl space-y-3">
                  <select name="client_id" required className={inputCls}>
                    <option value="">Select Client</option>
                    {clients.map(c => <option key={c.id} value={c.id}>{c.company_name || c.email}</option>)}
                  </select>
                  <input name="campaign_name" type="text" placeholder="Campaign Name" required className={inputCls} />
                  <input name="instantly_campaign_id" type="text" placeholder="Instantly Campaign ID" required className={inputCls} />
                  <button type="submit" className={`${btnPrimary} w-full`}>Add Campaign</button>
                </form>
              )}

              <div className="space-y-1">
                {filteredCampaigns.map(campaign => {
                  const client = clients.find(c => c.id === campaign.client_id)
                  return (
                    <div key={campaign.id} onClick={() => setSelectedCampaign(campaign)}
                      className="px-4 py-3 rounded-lg cursor-pointer hover:bg-[#111111] transition-colors group">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-[13px] text-white">{campaign.campaign_name}</p>
                          <p className="text-[12px] text-[#5A5A5A] mt-0.5">
                            {client?.company_name || 'Unknown'} · {campaign.instantly_campaign_id}
                          </p>
                        </div>
                        <span className="text-[11px] text-[#4A4A4A]">{campaign.status}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </motion.div>
          )}

          {activeSection === 'campaigns' && selectedCampaign && (
            <motion.div key="campaign-detail" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
              className="max-w-3xl mx-auto px-6 py-8">
              <CampaignAnalytics
                campaignId={selectedCampaign.instantly_campaign_id}
                campaignName={selectedCampaign.campaign_name}
                onBack={() => setSelectedCampaign(null)}
              />
            </motion.div>
          )}

          {/* ── Onboarding Steps ── */}
          {activeSection === 'onboarding' && (
            <motion.div key="onboarding" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
              className="max-w-3xl mx-auto px-6 py-8">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-base font-medium text-white">Onboarding</h2>
                <button onClick={() => setShowAddStep(v => !v)} className={btnPrimary}>
                  Add Step
                </button>
              </div>

              {showAddStep && (
                <form onSubmit={handleAddStep} className="mb-5 p-5 border border-[#1E1E1E] rounded-xl space-y-3">
                  <select name="client_id" required className={inputCls}>
                    <option value="">Select Client</option>
                    {clients.map(c => <option key={c.id} value={c.id}>{c.company_name || c.email}</option>)}
                  </select>
                  <input name="step_title" type="text" placeholder="Step Title" required className={inputCls} />
                  <textarea name="step_description" placeholder="Step Description" rows={3}
                    className={`${inputCls} resize-none`} />
                  <input name="order" type="number" placeholder="Order" required min="1" className={inputCls} />
                  <button type="submit" className={`${btnPrimary} w-full`}>Add Step</button>
                </form>
              )}

              <div className="space-y-1">
                {filteredSteps.map(step => {
                  const client = clients.find(c => c.id === step.client_id)
                  return (
                    <div key={step.id} className="px-4 py-3 rounded-lg hover:bg-[#111111] transition-colors">
                      <div className="flex items-start gap-3">
                        <button onClick={() => toggleStepCompletion(step.id, step.completed)}
                          className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center transition-colors shrink-0 ${
                            step.completed ? 'bg-[#5E6AD2] border-[#5E6AD2]' : 'border-[#3A3A3A] hover:border-[#5E6AD2]'
                          }`}>
                          {step.completed && (
                            <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </button>
                        <div className="flex-1 min-w-0">
                          <p className={`text-[13px] ${step.completed ? 'text-[#4A4A4A] line-through' : 'text-white'}`}>
                            {step.step_title}
                          </p>
                          {step.step_description && (
                            <p className="text-[12px] text-[#5A5A5A] mt-0.5">{step.step_description}</p>
                          )}
                          <p className="text-[11px] text-[#3A3A3A] mt-1">
                            {client?.company_name || 'Unknown'} · #{step.order}
                          </p>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </motion.div>
          )}

          {/* ── Onboarding Data ── */}
          {activeSection === 'onboarding-data' && (
            <motion.div key="onboarding-data" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
              className="max-w-3xl mx-auto px-6 py-8">
              <div className="mb-6">
                <h2 className="text-base font-medium text-white mb-4">Onboarding Data</h2>
                <select
                  value={onboardingDataClientId}
                  onChange={e => { setOnboardingDataClientId(e.target.value); if (e.target.value) loadStageData(e.target.value) }}
                  className={inputCls}
                  style={{ maxWidth: 280 }}
                >
                  <option value="">Select a client</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.company_name || c.email}</option>)}
                </select>
              </div>

              {onboardingDataClientId && (
                <div className="space-y-4">
                  {/* Stage 1 */}
                  <div className="border border-[#1E1E1E] rounded-xl p-5">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-[#5A5A5A] mb-4">Stage 1 — Inbox Setup</p>
                    {stageData.stage1 ? (
                      <div className="space-y-3">
                        {!!stageData.stage1.profile_picture_url && (
                          <div className="flex items-center gap-3">
                            <img src={String(stageData.stage1.profile_picture_url)} alt="Profile" className="w-10 h-10 rounded-full object-cover" />
                            <p className="text-[12px] text-[#5A5A5A]">Profile photo</p>
                          </div>
                        )}
                        {!!stageData.stage1.selected_domain && (
                          <div>
                            <p className="text-[11px] text-[#4A4A4A] mb-0.5">Selected domain</p>
                            <p className="text-[13px] text-white">{String(stageData.stage1.selected_domain)}</p>
                          </div>
                        )}
                      </div>
                    ) : <p className="text-[13px] text-[#4A4A4A]">Not completed yet</p>}
                  </div>

                  {/* Stage 2 */}
                  <div className="border border-[#1E1E1E] rounded-xl p-5">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-[#5A5A5A] mb-4">Stage 2 — Dream Client Questionnaire</p>
                    {stageData.stage2 ? (
                      <div className="space-y-3">
                        {([
                          ['Best client', 'best_client_description'],
                          ['Biggest problem', 'biggest_problem'],
                          ['Why said yes', 'why_said_yes'],
                          ['Result delivered', 'result_delivered'],
                          ['Red flags', 'red_flags'],
                          ['Clone client', 'clone_client'],
                        ] as [string, string][]).map(([label, key]) => !!stageData.stage2![key] && (
                          <div key={key}>
                            <p className="text-[11px] text-[#4A4A4A] mb-0.5">{label}</p>
                            <p className="text-[13px] text-white">{String(stageData.stage2![key])}</p>
                          </div>
                        ))}
                      </div>
                    ) : <p className="text-[13px] text-[#4A4A4A]">Not completed yet</p>}
                  </div>

                  {/* Stage 3 */}
                  <div className="border border-[#1E1E1E] rounded-xl p-5">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-[#5A5A5A] mb-4">Stage 3 — ICP & Targeting</p>
                    {stageData.stage3 ? (
                      <div className="space-y-3">
                        {([
                          ['Industries', 'industries'],
                          ['Company size', 'company_size'],
                          ['Revenue ranges', 'revenue_ranges'],
                          ['Locations', 'locations'],
                          ['Job titles (include)', 'job_titles_include'],
                          ['Job titles (exclude)', 'job_titles_exclude'],
                          ['Keywords (include)', 'keywords_include'],
                          ['Keywords (exclude)', 'keywords_exclude'],
                        ] as [string, string][]).map(([label, key]) => {
                          const val = stageData.stage3![key]
                          if (!val || (Array.isArray(val) && val.length === 0)) return null
                          return (
                            <div key={key}>
                              <p className="text-[11px] text-[#4A4A4A] mb-1">{label}</p>
                              <div className="flex flex-wrap gap-1">
                                {(Array.isArray(val) ? val as string[] : [String(val)]).map(v => (
                                  <span key={v} className="px-2 py-0.5 bg-[#1A1A1A] text-[#A0A0A0] text-[11px] rounded-full border border-[#2A2A2A]">{v}</span>
                                ))}
                              </div>
                            </div>
                          )
                        })}
                        {([
                          ['CTA type', 'cta_type'],
                          ['Deal size', 'deal_size_range'],
                          ['Offer description', 'offer_description'],
                          ['Best customer', 'best_customer_description'],
                          ['Calendly link', 'calendly_link'],
                        ] as [string, string][]).map(([label, key]) => !!stageData.stage3![key] && (
                          <div key={key}>
                            <p className="text-[11px] text-[#4A4A4A] mb-0.5">{label}</p>
                            <p className="text-[13px] text-white">{String(stageData.stage3![key])}</p>
                          </div>
                        ))}
                      </div>
                    ) : <p className="text-[13px] text-[#4A4A4A]">Not completed yet</p>}
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {/* ── Email Validator ── */}
          {activeSection === 'email-validator' && (
            <motion.div key="email-validator" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
              className="max-w-3xl mx-auto px-6 py-8">
              <EmailValidator />
            </motion.div>
          )}

        </AnimatePresence>
      </main>
    </div>
  )
}
