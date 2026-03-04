'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
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

export default function AdminDashboard() {
  const [clients, setClients] = useState<Client[]>([])
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [onboardingSteps, setOnboardingSteps] = useState<OnboardingStep[]>([])
  const [selectedClient, setSelectedClient] = useState<string | null>(null)
  const [showCreateClient, setShowCreateClient] = useState(false)
  const [showAddCampaign, setShowAddCampaign] = useState(false)
  const [showAddStep, setShowAddStep] = useState(false)
  const [activeSection, setActiveSection] = useState<'clients' | 'campaigns' | 'onboarding' | 'onboarding-data' | 'email-validator'>('clients')
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
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .eq('role', 'client')
      .order('created_at', { ascending: false })
    if (data) setClients(data)
  }

  const loadCampaigns = async () => {
    const { data } = await supabase
      .from('campaigns')
      .select('*')
      .order('created_at', { ascending: false })
    if (data) setCampaigns(data)
  }

  const loadOnboardingSteps = async () => {
    const { data } = await supabase
      .from('onboarding_steps')
      .select('*')
      .order('client_id', { ascending: true })
      .order('order', { ascending: true })
    if (data) setOnboardingSteps(data)
  }

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const handleCreateClient = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)
    const email = formData.get('email') as string
    const password = formData.get('password') as string
    const companyName = formData.get('company_name') as string

    // Create user
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          company_name: companyName,
        },
      },
    })

    if (authError) {
      alert(`Error creating client: ${authError.message}`)
      return
    }

    if (authData.user) {
      // Create profile
      const { error: profileError } = await supabase
        .from('profiles')
        .insert({
          id: authData.user.id,
          email,
          role: 'client',
          company_name: companyName,
        })

      if (profileError) {
        alert(`Error creating profile: ${profileError.message}`)
        return
      }

      setShowCreateClient(false)
      loadClients()
      ;(e.target as HTMLFormElement).reset()
    }
  }

  const handleAddCampaign = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)
    
    const { error } = await supabase.from('campaigns').insert({
      client_id: formData.get('client_id') as string,
      instantly_campaign_id: formData.get('instantly_campaign_id') as string,
      campaign_name: formData.get('campaign_name') as string,
      status: 'active',
    })

    if (error) {
      alert(`Error adding campaign: ${error.message}`)
      return
    }

    setShowAddCampaign(false)
    loadCampaigns()
    ;(e.target as HTMLFormElement).reset()
  }

  const handleAddStep = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)
    
    const { error } = await supabase.from('onboarding_steps').insert({
      client_id: formData.get('client_id') as string,
      step_title: formData.get('step_title') as string,
      step_description: formData.get('step_description') as string,
      order: parseInt(formData.get('order') as string),
      completed: false,
    })

    if (error) {
      alert(`Error adding step: ${error.message}`)
      return
    }

    setShowAddStep(false)
    loadOnboardingSteps()
    ;(e.target as HTMLFormElement).reset()
  }

  const toggleStepCompletion = async (stepId: string, currentStatus: boolean) => {
    const { error } = await supabase
      .from('onboarding_steps')
      .update({ completed: !currentStatus })
      .eq('id', stepId)

    if (error) {
      alert(`Error updating step: ${error.message}`)
      return
    }

    loadOnboardingSteps()
  }

  const filteredCampaigns = selectedClient
    ? campaigns.filter(c => c.client_id === selectedClient)
    : campaigns

  const filteredSteps = selectedClient
    ? onboardingSteps.filter(s => s.client_id === selectedClient)
    : onboardingSteps

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

  const STAGE_LABELS: Record<number, string> = {
    0: 'Pre-start', 1: 'Stage 1', 2: 'Stage 2', 3: 'Stage 3', 4: 'Complete',
  }

  const navItems = [
    { key: 'clients' as const, label: 'Clients' },
    { key: 'campaigns' as const, label: 'Campaigns' },
    { key: 'onboarding' as const, label: 'Onboarding' },
    { key: 'onboarding-data' as const, label: 'Onboarding Data' },
    { key: 'email-validator' as const, label: 'Email Validator' },
  ]

  return (
    <div className="min-h-screen bg-[#0A0A0A] flex">
      {/* Sidebar */}
      <aside className="w-56 bg-[#0A0A0A] border-r border-[#1E1E1E] flex flex-col min-h-screen">
        <div className="px-4 py-4 border-b border-[#1E1E1E]">
          <p className="text-sm font-medium text-white">NorthStar CRM</p>
        </div>
        <nav className="flex-1 px-2 py-3 space-y-0.5">
          {navItems.map((item) => (
            <button
              key={item.key}
              onClick={() => { setActiveSection(item.key); setSelectedCampaign(null) }}
              className={`w-full text-left px-3 py-1.5 rounded text-[13px] transition-colors ${
                activeSection === item.key
                  ? 'bg-[#1E1E1E] text-white'
                  : 'text-[#6B6B6B] hover:text-[#A0A0A0] hover:bg-[#141414]'
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="px-2 py-3 border-t border-[#1E1E1E]">
          <button
            onClick={handleLogout}
            className="w-full text-left px-3 py-1.5 rounded text-[13px] text-[#6B6B6B] hover:text-[#A0A0A0] hover:bg-[#141414] transition-colors"
          >
            Log out
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 p-8 overflow-auto">
        {activeSection === 'clients' && (
        <section>
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-base font-medium text-white">Clients</h2>
            <button
              onClick={() => setShowCreateClient(!showCreateClient)}
              className="px-3 py-1.5 bg-white text-[#0A0A0A] text-[13px] font-medium rounded hover:bg-[#E0E0E0] transition-colors"
            >
              Create Client
            </button>
          </div>

          {showCreateClient && (
            <form onSubmit={handleCreateClient} className="mb-5 p-4 border border-[#1E1E1E] rounded space-y-3">
              <input
                name="email"
                type="email"
                placeholder="Email"
                required
                className="w-full px-3 py-2 bg-[#0F0F0F] border border-[#1E1E1E] rounded text-sm text-white placeholder-[#4A4A4A] focus:outline-none focus:border-[#3A3A3A]"
              />
              <input
                name="password"
                type="password"
                placeholder="Password"
                required
                className="w-full px-3 py-2 bg-[#0F0F0F] border border-[#1E1E1E] rounded text-sm text-white placeholder-[#4A4A4A] focus:outline-none focus:border-[#3A3A3A]"
              />
              <input
                name="company_name"
                type="text"
                placeholder="Company Name"
                required
                className="w-full px-3 py-2 bg-[#0F0F0F] border border-[#1E1E1E] rounded text-sm text-white placeholder-[#4A4A4A] focus:outline-none focus:border-[#3A3A3A]"
              />
              <button
                type="submit"
                className="w-full px-3 py-2 bg-white text-[#0A0A0A] text-sm font-medium rounded hover:bg-[#E0E0E0] transition-colors"
              >
                Create
              </button>
            </form>
          )}

          <div className="space-y-2">
            {clients.map(client => (
              <div
                key={client.id}
                className="border border-[#1E1E1E] rounded p-4"
              >
                <div
                  className="flex items-center justify-between cursor-pointer"
                  onClick={() => setSelectedClient(client.id === selectedClient ? null : client.id)}
                >
                  <div>
                    <p className="text-sm text-white">{client.company_name || 'Unnamed Company'}</p>
                    <p className="text-xs text-[#6B6B6B] mt-0.5">{client.email}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`text-[11px] px-2 py-0.5 rounded border ${
                      client.onboarding_stage >= 4
                        ? 'border-[#2ECC71]/30 text-[#2ECC71]'
                        : client.onboarding_stage > 0
                        ? 'border-[#5E6AD2]/30 text-[#5E6AD2]'
                        : 'border-[#2A2A2A] text-[#4A4A4A]'
                    }`}>
                      {STAGE_LABELS[client.onboarding_stage] || 'Pre-start'}
                    </span>
                    <span className="text-xs text-[#4A4A4A]">
                      {new Date(client.created_at).toLocaleDateString()}
                    </span>
                  </div>
                </div>
                {/* DocuSign URL input */}
                <div className="mt-3 flex gap-2" onClick={e => e.stopPropagation()}>
                  <input
                    type="text"
                    value={docuSignInputs[client.id] ?? client.docusign_url ?? ''}
                    onChange={e => setDocuSignInputs(prev => ({ ...prev, [client.id]: e.target.value }))}
                    onBlur={e => saveDocuSignUrl(client.id, e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && saveDocuSignUrl(client.id, docuSignInputs[client.id] ?? '')}
                    placeholder="DocuSign URL (paste link to save)"
                    className="flex-1 px-2.5 py-1.5 bg-[#0A0A0A] border border-[#1E1E1E] rounded text-[12px] text-white placeholder-[#3A3A3A] focus:outline-none focus:border-[#3A3A3A]"
                  />
                  {(docuSignInputs[client.id] ?? client.docusign_url) && (
                    <span className="text-[11px] text-[#2ECC71] flex items-center">✓</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
        )}

        {activeSection === 'campaigns' && !selectedCampaign && (
        <section>
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-base font-medium text-white">Campaigns</h2>
            <button
              onClick={() => setShowAddCampaign(!showAddCampaign)}
              className="px-3 py-1.5 bg-white text-[#0A0A0A] text-[13px] font-medium rounded hover:bg-[#E0E0E0] transition-colors"
            >
              Add Campaign
            </button>
          </div>

          {showAddCampaign && (
            <form onSubmit={handleAddCampaign} className="mb-5 p-4 border border-[#1E1E1E] rounded space-y-3">
              <select
                name="client_id"
                required
                className="w-full px-3 py-2 bg-[#0F0F0F] border border-[#1E1E1E] rounded text-sm text-white focus:outline-none focus:border-[#3A3A3A]"
              >
                <option value="">Select Client</option>
                {clients.map(client => (
                  <option key={client.id} value={client.id}>
                    {client.company_name || client.email}
                  </option>
                ))}
              </select>
              <input
                name="campaign_name"
                type="text"
                placeholder="Campaign Name"
                required
                className="w-full px-3 py-2 bg-[#0F0F0F] border border-[#1E1E1E] rounded text-sm text-white placeholder-[#4A4A4A] focus:outline-none focus:border-[#3A3A3A]"
              />
              <input
                name="instantly_campaign_id"
                type="text"
                placeholder="Instantly Campaign ID"
                required
                className="w-full px-3 py-2 bg-[#0F0F0F] border border-[#1E1E1E] rounded text-sm text-white placeholder-[#4A4A4A] focus:outline-none focus:border-[#3A3A3A]"
              />
              <button
                type="submit"
                className="w-full px-3 py-2 bg-white text-[#0A0A0A] text-sm font-medium rounded hover:bg-[#E0E0E0] transition-colors"
              >
                Add Campaign
              </button>
            </form>
          )}

          <div className="space-y-px">
            {filteredCampaigns.map(campaign => {
              const client = clients.find(c => c.id === campaign.client_id)
              return (
                <div
                  key={campaign.id}
                  onClick={() => setSelectedCampaign(campaign)}
                  className="px-4 py-3 rounded cursor-pointer hover:bg-[#111111] transition-colors group"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-white group-hover:text-white">{campaign.campaign_name}</p>
                      <p className="text-xs text-[#6B6B6B] mt-0.5">
                        {client?.company_name || 'Unknown'} · {campaign.instantly_campaign_id}
                      </p>
                    </div>
                    <span className="text-[11px] text-[#4A4A4A]">
                      {campaign.status}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
        )}

        {activeSection === 'campaigns' && selectedCampaign && (
          <CampaignAnalytics
            campaignId={selectedCampaign.instantly_campaign_id}
            campaignName={selectedCampaign.campaign_name}
            onBack={() => setSelectedCampaign(null)}
          />
        )}

        {activeSection === 'onboarding' && (
        <section>
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-base font-medium text-white">Onboarding</h2>
            <button
              onClick={() => setShowAddStep(!showAddStep)}
              className="px-3 py-1.5 bg-white text-[#0A0A0A] text-[13px] font-medium rounded hover:bg-[#E0E0E0] transition-colors"
            >
              Add Step
            </button>
          </div>

          {showAddStep && (
            <form onSubmit={handleAddStep} className="mb-5 p-4 border border-[#1E1E1E] rounded space-y-3">
              <select
                name="client_id"
                required
                className="w-full px-3 py-2 bg-[#0F0F0F] border border-[#1E1E1E] rounded text-sm text-white focus:outline-none focus:border-[#3A3A3A]"
              >
                <option value="">Select Client</option>
                {clients.map(client => (
                  <option key={client.id} value={client.id}>
                    {client.company_name || client.email}
                  </option>
                ))}
              </select>
              <input
                name="step_title"
                type="text"
                placeholder="Step Title"
                required
                className="w-full px-3 py-2 bg-[#0F0F0F] border border-[#1E1E1E] rounded text-sm text-white placeholder-[#4A4A4A] focus:outline-none focus:border-[#3A3A3A]"
              />
              <textarea
                name="step_description"
                placeholder="Step Description"
                rows={3}
                className="w-full px-3 py-2 bg-[#0F0F0F] border border-[#1E1E1E] rounded text-sm text-white placeholder-[#4A4A4A] focus:outline-none focus:border-[#3A3A3A]"
              />
              <input
                name="order"
                type="number"
                placeholder="Order"
                required
                min="1"
                className="w-full px-3 py-2 bg-[#0F0F0F] border border-[#1E1E1E] rounded text-sm text-white placeholder-[#4A4A4A] focus:outline-none focus:border-[#3A3A3A]"
              />
              <button
                type="submit"
                className="w-full px-3 py-2 bg-white text-[#0A0A0A] text-sm font-medium rounded hover:bg-[#E0E0E0] transition-colors"
              >
                Add Step
              </button>
            </form>
          )}

          <div className="space-y-px">
            {filteredSteps.map(step => {
              const client = clients.find(c => c.id === step.client_id)
              return (
                <div key={step.id} className="px-4 py-3 rounded hover:bg-[#111111] transition-colors">
                  <div className="flex items-start gap-3">
                    <button
                      onClick={() => toggleStepCompletion(step.id, step.completed)}
                      className={`mt-0.5 w-4 h-4 rounded-sm border flex items-center justify-center transition-colors ${
                        step.completed
                          ? 'bg-[#5E6AD2] border-[#5E6AD2]'
                          : 'border-[#3A3A3A] hover:border-[#5E6AD2]'
                      }`}
                    >
                      {step.completed && (
                        <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </button>
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm ${step.completed ? 'text-[#4A4A4A] line-through' : 'text-white'}`}>
                        {step.step_title}
                      </p>
                      {step.step_description && (
                        <p className="text-xs text-[#6B6B6B] mt-0.5">{step.step_description}</p>
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
        </section>
        )}

        {activeSection === 'onboarding-data' && (
        <section>
          <div className="mb-5">
            <h2 className="text-base font-medium text-white mb-3">Onboarding Data</h2>
            <select
              value={onboardingDataClientId}
              onChange={e => {
                setOnboardingDataClientId(e.target.value)
                if (e.target.value) loadStageData(e.target.value)
              }}
              className="px-3 py-2 bg-[#0F0F0F] border border-[#1E1E1E] rounded text-sm text-white focus:outline-none focus:border-[#3A3A3A]"
            >
              <option value="">Select a client</option>
              {clients.map(c => (
                <option key={c.id} value={c.id}>{c.company_name || c.email}</option>
              ))}
            </select>
          </div>

          {onboardingDataClientId && (
            <div className="space-y-5">
              {/* Stage 1 */}
              <div className="border border-[#1E1E1E] rounded p-5">
                <p className="text-[11px] font-medium uppercase tracking-wider text-[#6B6B6B] mb-3">Stage 1 — Inbox Setup</p>
                {stageData.stage1 ? (
                  <div className="space-y-3">
                    {!!stageData.stage1.profile_picture_url && (
                      <div className="flex items-center gap-3">
                        <img src={String(stageData.stage1.profile_picture_url)} alt="Profile" className="w-12 h-12 rounded-full object-cover" />
                        <div>
                          <p className="text-[11px] text-[#4A4A4A]">Profile photo</p>
                        </div>
                      </div>
                    )}
                    {!!stageData.stage1.selected_domain && (
                      <div>
                        <p className="text-[11px] text-[#4A4A4A] mb-0.5">Selected domain</p>
                        <p className="text-sm text-white">{String(stageData.stage1.selected_domain)}</p>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-[13px] text-[#4A4A4A]">Not completed yet</p>
                )}
              </div>

              {/* Stage 2 */}
              <div className="border border-[#1E1E1E] rounded p-5">
                <p className="text-[11px] font-medium uppercase tracking-wider text-[#6B6B6B] mb-3">Stage 2 — Dream Client Questionnaire</p>
                {stageData.stage2 ? (
                  <div className="space-y-3">
                    {[
                      ['Best client', 'best_client_description'],
                      ['Biggest problem', 'biggest_problem'],
                      ['Why said yes', 'why_said_yes'],
                      ['Result delivered', 'result_delivered'],
                      ['Red flags', 'red_flags'],
                      ['Clone client', 'clone_client'],
                    ].map(([label, key]) => !!stageData.stage2![key] && (
                      <div key={key}>
                        <p className="text-[11px] text-[#4A4A4A] mb-0.5">{label}</p>
                        <p className="text-[13px] text-white">{String(stageData.stage2![key])}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-[13px] text-[#4A4A4A]">Not completed yet</p>
                )}
              </div>

              {/* Stage 3 */}
              <div className="border border-[#1E1E1E] rounded p-5">
                <p className="text-[11px] font-medium uppercase tracking-wider text-[#6B6B6B] mb-3">Stage 3 — ICP & Targeting</p>
                {stageData.stage3 ? (
                  <div className="space-y-3">
                    {[
                      ['Industries', 'industries'],
                      ['Company size', 'company_size'],
                      ['Revenue ranges', 'revenue_ranges'],
                      ['Locations', 'locations'],
                      ['Buying signals', 'buying_signals'],
                      ['Job titles (include)', 'job_titles_include'],
                      ['Job titles (exclude)', 'job_titles_exclude'],
                      ['Keywords (include)', 'keywords_include'],
                      ['Keywords (exclude)', 'keywords_exclude'],
                    ].map(([label, key]) => {
                      const val = stageData.stage3![key]
                      if (!val || (Array.isArray(val) && val.length === 0)) return null
                      return (
                        <div key={key}>
                          <p className="text-[11px] text-[#4A4A4A] mb-1">{label}</p>
                          <div className="flex flex-wrap gap-1">
                            {(Array.isArray(val) ? val as string[] : [String(val)]).map((v) => (
                              <span key={v} className="px-2 py-0.5 bg-[#1E1E1E] text-[#A0A0A0] text-[11px] rounded">{v}</span>
                            ))}
                          </div>
                        </div>
                      )
                    })}
                    {[
                      ['CTA type', 'cta_type'],
                      ['Deal size', 'deal_size_range'],
                      ['Offer description', 'offer_description'],
                      ['Best customer', 'best_customer_description'],
                      ['Calendly link', 'calendly_link'],
                    ].map(([label, key]) => !!stageData.stage3![key] && (
                      <div key={key}>
                        <p className="text-[11px] text-[#4A4A4A] mb-0.5">{label}</p>
                        <p className="text-[13px] text-white">{String(stageData.stage3![key])}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-[13px] text-[#4A4A4A]">Not completed yet</p>
                )}
              </div>
            </div>
          )}
        </section>
        )}

        {activeSection === 'email-validator' && <EmailValidator />}
      </main>
    </div>
  )
}
